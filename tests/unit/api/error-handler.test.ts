import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  HttpError,
  NotFoundError,
  BadRequestError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  InternalError,
  apiError,
  onError,
} from '@/api/middleware/error-handler';

/**
 * Minimal Context stub. `apiError` touches exactly one Context method —
 * `c.json(body, status)` — so we capture that single call.
 */
function stubContext() {
  let jsonCall: { body: unknown; status: number } | undefined;
  const c = {
    json(body: unknown, status: number) {
      jsonCall = { body, status };
      return { status, body } as unknown as Response;
    },
  };
  return {
    c: c as unknown as Context,
    get jsonCall() {
      return jsonCall;
    },
  };
}

/**
 * Build a real Hono app whose `GET /api/throw` route throws `value`, with the
 * global `onError` wired exactly as `api-app.ts` wires it. This exercises the
 * full Hono dispatch path (route throw → `app.onError`) end-to-end, which is
 * the only path that actually fires in production — a middleware `try/catch`
 * does NOT catch route-handler throws (verified against hono@4.12.23).
 *
 * Note: Hono only routes *Error instances* to `app.onError`. A non-Error
 * throw (string / number / undefined) instead rejects the `app.request()`
 * promise itself and never reaches `onError`; the defensive non-Error branch
 * is therefore covered by direct invocation below.
 */
function appThatThrows(value: unknown) {
  const app = new Hono();
  app.onError(onError);
  app.get('/api/throw', () => {
    throw value;
  });
  // A normal route to prove the error handler never interferes with success.
  app.get('/api/ok', (c) => c.json({ ok: true }));
  return app;
}

/** Request the throwing route; return { status, body } of the response. */
async function dispatchThrow(value: unknown) {
  const res = await appThatThrows(value).request('/api/throw');
  const body = await res.json();
  return { status: res.status, body };
}

/**
 * Invoke `onError` directly with `value`. Used to cover the defensive
 * non-Error branch that Hono's dispatch never reaches (non-Error throws
 * reject `app.request()` instead of hitting `app.onError`).
 */
function dispatchDirect(value: unknown) {
  const ctx = stubContext();
  onError(value as Error, ctx.c);
  return ctx.jsonCall;
}

beforeEach(() => {
  // onError logs unhandled (non-HttpError) errors to console.error.
  // Silence the noise and let individual tests assert on the spy.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Restore so each test gets a fresh spy (call counts don't accumulate).
  vi.restoreAllMocks();
});

describe('HttpError base class', () => {
  it('constructor sets status / code / message / details', () => {
    const err = new HttpError(418, "I'M_A_TEAPOT", 'brew failed', { pot: 'empty' });
    expect(err.status).toBe(418);
    expect(err.code).toBe("I'M_A_TEAPOT");
    expect(err.message).toBe('brew failed');
    expect(err.details).toEqual({ pot: 'empty' });
  });

  it('is a real Error subclass with message and stack', () => {
    const err = new HttpError(500, 'X', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
    expect(typeof err.stack).toBe('string');
    expect(err.stack).toContain('boom');
  });

  it('name reflects the concrete constructor name', () => {
    expect(new HttpError(500, 'X', 'x').name).toBe('HttpError');
    expect(new NotFoundError('x').name).toBe('NotFoundError');
  });
});

describe('subclass status + code are built-in', () => {
  it('NotFoundError → 404 / NOT_FOUND', () => {
    const e = new NotFoundError('missing');
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(404);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe('missing');
  });

  it('BadRequestError → 400 / BAD_REQUEST', () => {
    const e = new BadRequestError('nope');
    expect(e.status).toBe(400);
    expect(e.code).toBe('BAD_REQUEST');
  });

  it('ValidationError → 400 / VALIDATION_ERROR', () => {
    const e = new ValidationError('bad input');
    expect(e.status).toBe(400);
    expect(e.code).toBe('VALIDATION_ERROR');
  });

  it('UnauthorizedError → 401 / UNAUTHORIZED with default message', () => {
    const defaulted = new UnauthorizedError();
    expect(defaulted.status).toBe(401);
    expect(defaulted.code).toBe('UNAUTHORIZED');
    expect(defaulted.message).toBe('Authentication required');

    const explicit = new UnauthorizedError('need login');
    expect(explicit.message).toBe('need login');
  });

  it('ForbiddenError → 403 / FORBIDDEN with default message', () => {
    const defaulted = new ForbiddenError();
    expect(defaulted.status).toBe(403);
    expect(defaulted.code).toBe('FORBIDDEN');
    expect(defaulted.message).toBe('Access denied');
  });

  it('ConflictError → 409 / CONFLICT', () => {
    const e = new ConflictError('dup');
    expect(e.status).toBe(409);
    expect(e.code).toBe('CONFLICT');
  });

  it('InternalError → 500 / INTERNAL_ERROR with default message', () => {
    const defaulted = new InternalError();
    expect(defaulted.status).toBe(500);
    expect(defaulted.code).toBe('INTERNAL_ERROR');
    expect(defaulted.message).toBe('Internal server error');
  });
});

describe('apiError', () => {
  it('returns { error: <string>, code } with the right HTTP status', () => {
    const ctx = stubContext();
    apiError(ctx.c, 404, 'NOT_FOUND', 'no such thing');
    const { body, status } = ctx.jsonCall!;

    expect(status).toBe(404);
    // Frontend reads `data.error` directly — it MUST be a plain string.
    expect(typeof (body as { error: unknown }).error).toBe('string');
    expect((body as { error: string }).error).toBe('no such thing');
    expect((body as { code: string }).code).toBe('NOT_FOUND');
    expect(body).not.toHaveProperty('details');
  });

  it('includes details only when provided', () => {
    const ctx = stubContext();
    apiError(ctx.c, 400, 'BAD_REQUEST', 'bad', [{ field: 'title' }]);
    const { body, status } = ctx.jsonCall!;

    expect(status).toBe(400);
    expect((body as { details: unknown }).details).toEqual([{ field: 'title' }]);
  });
});

describe('onError dispatch (end-to-end via real Hono app)', () => {
  it('a successful route returns 200 and never invokes the error handler', async () => {
    const res = await appThatThrows(new Error('unused')).request('/api/ok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('does not log HttpError subclasses (they are expected, handled errors)', async () => {
    await dispatchThrow(new NotFoundError('gone'));
    expect(console.error).not.toHaveBeenCalled();
  });

  it('NotFoundError → 404 + NOT_FOUND', async () => {
    const { status, body } = await dispatchThrow(new NotFoundError('gone'));
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'gone', code: 'NOT_FOUND' });
  });

  it('BadRequestError → 400 + BAD_REQUEST', async () => {
    const { status, body } = await dispatchThrow(new BadRequestError('bad'));
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bad', code: 'BAD_REQUEST' });
  });

  it('ValidationError → 400 + VALIDATION_ERROR, details carried through', async () => {
    const { status, body } = await dispatchThrow(new ValidationError('invalid', { field: 'title' }));
    expect(status).toBe(400);
    expect(body).toEqual({
      error: 'invalid',
      code: 'VALIDATION_ERROR',
      details: { field: 'title' },
    });
  });

  it('UnauthorizedError → 401 + UNAUTHORIZED', async () => {
    const { status, body } = await dispatchThrow(new UnauthorizedError('no token'));
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'no token', code: 'UNAUTHORIZED' });
  });

  it('ForbiddenError → 403 + FORBIDDEN', async () => {
    const { status, body } = await dispatchThrow(new ForbiddenError('nope'));
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'nope', code: 'FORBIDDEN' });
  });

  it('ConflictError → 409 + CONFLICT', async () => {
    const { status, body } = await dispatchThrow(new ConflictError('clash'));
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'clash', code: 'CONFLICT' });
  });

  it('InternalError → 500 + INTERNAL_ERROR', async () => {
    const { status, body } = await dispatchThrow(new InternalError('kaboom'));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'kaboom', code: 'INTERNAL_ERROR' });
  });

  it('plain Error with benign message → 500 + INTERNAL_ERROR (message surfaced)', async () => {
    const { status, body } = await dispatchThrow(new Error('something broke unexpectedly'));
    expect(status).toBe(500);
    expect(body).toEqual({
      error: 'something broke unexpectedly',
      code: 'INTERNAL_ERROR',
    });
    // Unhandled errors are logged for observability.
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('non-Error throw (string) → 500 + generic message', async () => {
    // Hono never passes a non-Error throw to app.onError (it rejects
    // app.request instead), so cover the defensive branch by direct call.
    const call = dispatchDirect('boom');
    expect(call!.status).toBe(500);
    expect(call!.body).toEqual({
      error: 'An unexpected error occurred',
      code: 'INTERNAL_ERROR',
    });
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('non-Error throw (undefined) → 500 + generic message', async () => {
    const call = dispatchDirect(undefined);
    expect(call!.status).toBe(500);
    expect(call!.body).toEqual({
      error: 'An unexpected error occurred',
      code: 'INTERNAL_ERROR',
    });
    expect(console.error).toHaveBeenCalledOnce();
  });
});

describe('regression: status is NOT sniffed from the message text', () => {
  // The old implementation read `err.message.includes('not found')` etc. to
  // derive a status code. These cases lock down that the handler now dispatches
  // purely on `instanceof HttpError`: a *plain* Error must always be 500, no
  // matter which keywords its message happens to contain.

  it('plain Error whose message contains "not found" is still 500', async () => {
    const { status, body } = await dispatchThrow(new Error('something not found here'));
    expect(status).toBe(500);
    expect((body as { code: string }).code).toBe('INTERNAL_ERROR');
  });

  it('plain Error whose message contains "unauthorized" is still 500', async () => {
    const { status, body } = await dispatchThrow(new Error('you are unauthorized for this'));
    expect(status).toBe(500);
    expect((body as { code: string }).code).toBe('INTERNAL_ERROR');
  });

  it('plain Error whose message contains "forbidden" is still 500', async () => {
    const { status, body } = await dispatchThrow(new Error('this is forbidden content'));
    expect(status).toBe(500);
    expect((body as { code: string }).code).toBe('INTERNAL_ERROR');
  });

  it('contrast: an actual NotFoundError with the SAME wording is 404', async () => {
    // Same string, different class → different status. Proves the dispatch key
    // is the class, not the text.
    const { status, body } = await dispatchThrow(new NotFoundError('something not found here'));
    expect(status).toBe(404);
    expect((body as { code: string }).code).toBe('NOT_FOUND');
  });
});
