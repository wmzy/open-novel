import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { config } from '../../config';
import { UnauthorizedError } from './error-handler';

/**
 * Optional API authentication.
 *
 * The server is loopback-only by default, so auth is opt-in. When
 * `AUTH_TOKEN` is set, every `/api/*` request (including SSE streams) must
 * present the token. Static assets and `/api/health` stay public.
 *
 * Accepted credentials:
 *   1. `Authorization: Bearer <token>` — for scripts / API clients.
 *   2. `open_novel_auth` HttpOnly cookie — set by the one-time login below,
 *      and automatically sent by same-origin `fetch` and `EventSource`
 *      (EventSource cannot attach custom headers, hence the cookie path).
 *   3. `?token=<token>` — one-time login: validates, sets the cookie, then
 *      redirects to the same URL with the query parameter stripped so the
 *      token does not linger in browser history / server logs.
 *
 * Comparisons hash both sides first so `crypto.timingSafeEqual` never throws
 * on differing lengths and the comparison time does not leak token length.
 */

export const AUTH_COOKIE_NAME = 'open_novel_auth';

/** 30 days — long enough that the one-time login is not a daily chore. */
const AUTH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/** True for hosts that only accept connections from the local machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
  );
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time string comparison. Both inputs are hashed to fixed-length
 * digests first, so unequal lengths are safe and do not short-circuit.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function withoutToken(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.delete('token');
  return `${url.pathname}${url.search}`;
}

function setAuthCookie(c: Context, token: string): void {
  setCookie(c, AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE,
    // Only mark Secure when this request arrived over TLS. TLS-terminating
    // proxies terminate before us, so the internal hop is plain HTTP.
    secure: new URL(c.req.url).protocol === 'https:',
  });
}

export function createAuthMiddleware(
  getToken: () => string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    const expected = getToken();
    // No token configured -> auth disabled (loopback-only default).
    if (!expected) return next();

    // CORS preflight requests never carry credentials; let them through so
    // the actual request still gets a CORS response when unauthenticated.
    if (c.req.method === 'OPTIONS') return next();

    // One-time login: /any/api/path?token=<AUTH_TOKEN>.
    // Handled before the health exemption so /api/health?token=... works as
    // a convenient login URL.
    const queryToken = c.req.query('token');
    if (queryToken !== undefined) {
      if (!timingSafeEqualStrings(queryToken, expected)) {
        throw new UnauthorizedError('访问令牌无效');
      }
      setAuthCookie(c, expected);
      // Strip the token from the address bar; EventSource follows the
      // redirect and reconnects with the cookie.
      if (c.req.method === 'GET' || c.req.method === 'HEAD') {
        return c.redirect(withoutToken(c.req.url), 302);
      }
      return next();
    }

    // Health stays public for monitoring / container probes.
    if (c.req.path === '/api/health') return next();

    const cookieToken = getCookie(c, AUTH_COOKIE_NAME);
    if (cookieToken && timingSafeEqualStrings(cookieToken, expected)) {
      return next();
    }

    const bearer = bearerFrom(c.req.header('authorization'));
    if (bearer && timingSafeEqualStrings(bearer, expected)) {
      return next();
    }

    throw new UnauthorizedError(
      '认证失败：请使用 Authorization: Bearer <AUTH_TOKEN>，或先在浏览器打开 /api/health?token=<AUTH_TOKEN> 完成登录',
    );
  };
}

/** Middleware wired into the app; reads AUTH_TOKEN lazily per request. */
export const authMiddleware = createAuthMiddleware(() => config.auth.token);
