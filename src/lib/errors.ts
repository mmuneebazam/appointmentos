/**
 * A single error type that carries an HTTP status and a machine-readable code.
 * Route handlers translate it; nothing else needs to know about HTTP.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, 'bad_request', msg, details)
export const unauthorized = (msg = 'Sign in required') => new AppError(401, 'unauthorized', msg)
export const forbidden = (msg = 'Not allowed') => new AppError(403, 'forbidden', msg)
export const notFound = (msg = 'Not found') => new AppError(404, 'not_found', msg)
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'conflict', msg, details)
export const tooMany = (msg = 'Too many requests') => new AppError(429, 'rate_limited', msg)
export const unprocessable = (msg: string, details?: unknown) =>
  new AppError(422, 'unprocessable', msg, details)

export function errorResponse(err: unknown) {
  if (err instanceof AppError) {
    return Response.json(
      { error: { code: err.code, message: err.message, details: err.details ?? null } },
      { status: err.status },
    )
  }
  // Never leak internals to the client; log for the operator.
  console.error('[unhandled]', err)
  return Response.json(
    { error: { code: 'internal_error', message: 'Something went wrong' } },
    { status: 500 },
  )
}

/** Wrap a route handler so thrown AppErrors become clean JSON. */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await fn(...args)
    } catch (err) {
      return errorResponse(err)
    }
  }
}
