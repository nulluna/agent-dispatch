interface ErrorPayload {
  error: {
    code: string
    message: string
  }
}

export class DispatchError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DispatchError'
  }

  toResponse(): Response {
    return jsonErrorResponse(this.status, this.code, this.message)
  }
}

export function jsonErrorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  const payload: ErrorPayload = {
    error: {
      code,
      message,
    },
  }

  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  })
}
