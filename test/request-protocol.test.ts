import { describe, expect, it } from 'vitest'

import { detectLlmRequestInfo } from '../src/request-protocol'

function createBufferedBody(payload: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer
}

function createRequest(
  input: string,
  init?: RequestInit,
): { request: Request; upstreamUrl: URL } {
  const request = new Request(`http://127.0.0.1${input}`, init)
  const upstreamUrl = new URL(`https://example.com${input}`)
  return { request, upstreamUrl }
}

describe('detectLlmRequestInfo', () => {
  it('recognizes OpenAI Completions requests by path', () => {
    const { request, upstreamUrl } = createRequest('/v1/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'openai-sdk',
      },
    })

    expect(
      detectLlmRequestInfo(
        request,
        upstreamUrl,
        createBufferedBody({ model: 'gpt-3.5-turbo-instruct', prompt: 'hello' }),
      ),
    ).toEqual({
      protocol: 'openai-completions',
      modelId: 'gpt-3.5-turbo-instruct',
      userAgent: 'openai-sdk',
    })
  })

  it('recognizes OpenAI Chat Completions requests by schema on non-standard paths', () => {
    const { request, upstreamUrl } = createRequest('/custom/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'cursor-agent',
      },
    })

    expect(
      detectLlmRequestInfo(
        request,
        upstreamUrl,
        createBufferedBody({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      ),
    ).toEqual({
      protocol: 'openai-chat-completions',
      modelId: 'gpt-4.1',
      userAgent: 'cursor-agent',
    })
  })

  it('recognizes OpenAI Responses requests by path', () => {
    const { request, upstreamUrl } = createRequest('/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'openai-agents',
      },
    })

    expect(
      detectLlmRequestInfo(
        request,
        upstreamUrl,
        createBufferedBody({ model: 'gpt-5', input: 'hello' }),
      ),
    ).toEqual({
      protocol: 'openai-responses',
      modelId: 'gpt-5',
      userAgent: 'openai-agents',
    })
  })

  it('recognizes Anthropic Messages requests by schema on non-standard paths', () => {
    const { request, upstreamUrl } = createRequest('/gateway/invoke', {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'user-agent': 'claude-code',
      },
    })

    expect(
      detectLlmRequestInfo(
        request,
        upstreamUrl,
        createBufferedBody({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      ),
    ).toEqual({
      protocol: 'anthropic-messages',
      modelId: 'claude-sonnet-4-20250514',
      userAgent: 'claude-code',
    })
  })

  it('returns null for unrelated JSON requests', () => {
    const { request, upstreamUrl } = createRequest('/internal/health', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'internal-client',
      },
    })

    expect(
      detectLlmRequestInfo(
        request,
        upstreamUrl,
        createBufferedBody({ status: 'ok' }),
      ),
    ).toBeNull()
  })
})
