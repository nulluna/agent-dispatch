export type KnownLlmRequestProtocol =
  | 'openai-completions'
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages'

export interface LlmRequestInfo {
  protocol: KnownLlmRequestProtocol
  modelId: string
  userAgent: string
}

const CREATE_PATH_PROTOCOLS = new Map<string, KnownLlmRequestProtocol>([
  ['/v1/completions', 'openai-completions'],
  ['/v1/chat/completions', 'openai-chat-completions'],
  ['/v1/responses', 'openai-responses'],
  ['/v1/messages', 'anthropic-messages'],
])

function normalizePath(pathname: string): string {
  const normalizedPath = pathname.replace(/\/+$/g, '')
  return normalizedPath || '/'
}

function isJsonContentType(headers: Headers): boolean {
  const contentType = headers.get('content-type')?.toLowerCase() ?? ''
  return contentType.includes('json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function hasMessagesField(record: Record<string, unknown>): boolean {
  return Array.isArray(record.messages)
}

function hasPromptField(record: Record<string, unknown>): boolean {
  return hasOwn(record, 'prompt')
}

function hasResponsesField(record: Record<string, unknown>): boolean {
  return hasOwn(record, 'input')
    || hasOwn(record, 'instructions')
    || hasOwn(record, 'previous_response_id')
}

function parseJsonBody(bufferedBody: ArrayBuffer | null, headers: Headers): Record<string, unknown> | null {
  if (!bufferedBody || bufferedBody.byteLength === 0 || !isJsonContentType(headers)) {
    return null
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bufferedBody)) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function detectByPath(request: Request, upstreamUrl: URL): KnownLlmRequestProtocol | null {
  if (request.method.toUpperCase() !== 'POST') {
    return null
  }

  return CREATE_PATH_PROTOCOLS.get(normalizePath(upstreamUrl.pathname)) ?? null
}

function detectByBody(
  request: Request,
  body: Record<string, unknown> | null,
): KnownLlmRequestProtocol | null {
  if (!body || request.method.toUpperCase() !== 'POST') {
    return null
  }

  if (request.headers.has('anthropic-version') && hasMessagesField(body) && hasOwn(body, 'max_tokens')) {
    return 'anthropic-messages'
  }

  if (hasPromptField(body)) {
    return 'openai-completions'
  }

  if (hasResponsesField(body)) {
    return 'openai-responses'
  }

  if (hasMessagesField(body)) {
    return 'openai-chat-completions'
  }

  return null
}

function readModelId(body: Record<string, unknown> | null, upstreamUrl: URL): string | null {
  if (body) {
    const bodyModelId = readStringField(body, 'model')
    if (bodyModelId) {
      return bodyModelId
    }
  }

  const queryModelId = upstreamUrl.searchParams.get('model')?.trim()
  return queryModelId ? queryModelId : null
}

export function detectLlmRequestInfo(
  request: Request,
  upstreamUrl: URL,
  bufferedBody: ArrayBuffer | null,
): LlmRequestInfo | null {
  const body = parseJsonBody(bufferedBody, request.headers)
  const protocol = detectByPath(request, upstreamUrl) ?? detectByBody(request, body)

  if (!protocol) {
    return null
  }

  const modelId = readModelId(body, upstreamUrl)

  if (!modelId) {
    return null
  }

  return {
    protocol,
    modelId,
    userAgent: request.headers.get('user-agent')?.trim() || 'unknown',
  }
}
