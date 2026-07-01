import type { Context, Next } from 'hono';

/**
 * Security headers middleware.
 */
export async function securityHeaders(c: Context, next: Next) {
  await next();

  // Content Security Policy
  c.header('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
  ].join('; '));

  // Other security headers
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/**
 * Simple in-memory rate limiter with automatic cleanup.
 */
const requestCounts = new Map<string, { count: number; resetTime: number }>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestCounts) {
    if (now > entry.resetTime) {
      requestCounts.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Trusted internal header injected by the server entry points
 * (`src/server/request-adapter.ts`) from `req.socket.remoteAddress`. Unlike
 * client-controllable headers (`x-forwarded-for`, `x-real-ip`) it cannot be
 * forged, which makes it safe to use as a rate-limit key.
 */
const REMOTE_ADDR_HEADER = 'x-internal-remote-addr';

/**
 * Resolve the real client IP for rate limiting.
 *
 * Reads only the server-injected internal header. When absent (e.g. in-process
 * integration tests that call `app.request` directly with no real socket) it
 * falls back to `'unknown'` so a single shared bucket is used instead of
 * erroring.
 */
function getClientIp(c: Context): string {
  return c.req.header(REMOTE_ADDR_HEADER) || 'unknown';
}

export function rateLimit(maxRequests = 100, windowMs = 60000) {
  return async (c: Context, next: Next) => {
    const ip = getClientIp(c);
    const now = Date.now();
    const key = `${ip}`;

    let entry = requestCounts.get(key);
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + windowMs };
      requestCounts.set(key, entry);
    }

    entry.count++;

    if (entry.count > maxRequests) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    await next();
  };
}

/**
 * Validate request body size.
 */
export function maxBodySize(maxBytes: number) {
  return async (c: Context, next: Next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && parseInt(contentLength) > maxBytes) {
      return c.json({ error: 'Request body too large' }, 413);
    }
    await next();
  };
}
