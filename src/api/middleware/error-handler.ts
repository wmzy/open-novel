import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Structured HTTP error. Carries a semantic status + code so the global
 * error handler can dispatch via `instanceof` instead of fragile string
 * sniffing on `err.message`.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    // Preserve the concrete subclass name for debugging/logging.
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(404, 'NOT_FOUND', message, details);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Authentication required', details?: unknown) {
    super(401, 'UNAUTHORIZED', message, details);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Access denied', details?: unknown) {
    super(403, 'FORBIDDEN', message, details);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, 'CONFLICT', message, details);
  }
}

export class InternalError extends HttpError {
  constructor(message = 'Internal server error', details?: unknown) {
    super(500, 'INTERNAL_ERROR', message, details);
  }
}

export interface ApiError {
  /** Plain-string error message (frontend reads this directly). */
  error: string;
  code: string;
  details?: unknown;
}

/**
 * Create a standardized API error response.
 *
 * The response body keeps `error` as a plain string for frontend
 * compatibility (toast displays `data.error` directly).
 */
export function apiError(c: Context, status: number, code: string, message: string, details?: unknown) {
  const body: ApiError = { error: message, code };
  if (details !== undefined) body.details = details;
  return c.json(body, status as ContentfulStatusCode);
}

/**
 * Global Hono error handler (registered via `app.onError`).
 *
 * Hono's middleware `try { await next() } catch` form does NOT catch throws
 * from route handlers — Hono's `compose` routes them to `app.onError` instead
 * (verified against hono@4.12.23 dist/compose.js). So the global handler MUST
 * be wired as `app.onError`, not as a middleware.
 *
 * Dispatches on `instanceof HttpError` rather than inspecting message text.
 */
export function onError(err: Error, c: Context): Response {
  if (err instanceof HttpError) {
    return apiError(c, err.status, err.code, err.message, err.details);
  }

  console.error('Unhandled error:', err);

  const message = err instanceof Error ? err.message : 'An unexpected error occurred';
  return apiError(c, 500, 'INTERNAL_ERROR', message);
}
