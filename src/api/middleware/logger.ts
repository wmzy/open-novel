import pino from 'pino';
import type { Context, Next } from 'hono';

/**
 * Create a pino logger instance.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

/**
 * Request logging middleware for Hono.
 */
export async function requestLogger(c: Context, next: Next) {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  // Generate request ID
  const requestId = crypto.randomUUID().slice(0, 8);
  c.set('requestId', requestId);

  logger.info({ requestId, method, path }, '→ Request');

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  logger.info({ requestId, method, path, status, duration: `${duration}ms` }, '← Response');
}

/**
 * Create a child logger with request context.
 */
export function getRequestLogger(c: Context) {
  const requestId = c.get('requestId') || 'unknown';
  return logger.child({ requestId });
}
