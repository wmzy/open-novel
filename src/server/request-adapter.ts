import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Internal-only header carrying the socket's real remote address.
 *
 * It is injected by our own server entry points (the Vite dev middleware and
 * the production `node:http` server) from `req.socket.remoteAddress`, after
 * stripping any client-supplied value. Because it is server-controlled it is
 * safe to use as a rate-limit key; unlike `x-forwarded-for` / `x-real-ip`,
 * clients cannot forge it.
 */
export const REMOTE_ADDR_HEADER = 'x-internal-remote-addr';

/**
 * Build a web `Request` from a Node.js `IncomingMessage`.
 *
 * A trusted `x-internal-remote-addr` header is injected from
 * `req.socket.remoteAddress`. Any client-supplied value for that header is
 * discarded first so it cannot be spoofed. The API rate limiter reads this
 * header as its key (falling back to `'unknown'`).
 *
 * @param req            Node.js incoming request.
 * @param urlPathPrefix  Prefix prepended to `req.url` to reconstruct the full
 *                       path — used by mount points (e.g. the Vite `/api`
 *                       connect middleware) that strip a base path.
 */
export async function nodeRequestToFetchRequest(
  req: IncomingMessage,
  urlPathPrefix = '',
): Promise<Request> {
  const base = `http://${req.headers.host || 'localhost'}`;
  const url = new URL(`${urlPathPrefix}${req.url || '/'}`, base);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    // Never trust a client-supplied internal remote-addr header.
    if (key.toLowerCase() === REMOTE_ADDR_HEADER) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const remoteAddress = req.socket?.remoteAddress;
  if (remoteAddress) {
    headers.set(REMOTE_ADDR_HEADER, remoteAddress);
  }

  const body =
    req.method !== 'GET' && req.method !== 'HEAD'
      ? await new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks)));
        })
      : undefined;

  return new Request(url.toString(), { method: req.method, headers, body: body as BodyInit });
}

/**
 * Write a web `Response` back onto a Node.js `ServerResponse`.
 *
 * Pumps the response body chunk by chunk. This is a local single-user server,
 * so backpressure is not handled; this mirrors the original Vite dev plugin's
 * behaviour.
 */
export async function writeFetchResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
