import { createServer } from 'node:http';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import pino from 'pino';
import app from '../api-app';
import { ensureDbReady, closeDb } from '../db/drizzle';
import { startPeriodicBackup } from '../db/backup';
import { initPlugins } from '../plugins/registry';
import { deploySubagents } from '../agent/subagents';
import { config } from '../config';
import { nodeRequestToFetchRequest, writeFetchResponse } from './request-adapter';

/**
 * Production server entry.
 *
 * Bundled by scripts/build-server.mjs into dist/server/api.js. Resolves the
 * sibling client build (dist/client) relative to this file so it works
 * regardless of the process working directory.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, '../client');
const indexHtmlPath = path.join(clientRoot, 'index.html');

// Serve built client assets. serveStatic calls next() on a miss, letting the
// SPA fallback below handle client-side routes.
app.use('/*', serveStatic({ root: clientRoot }));

// SPA fallback: any non-API GET that did not match a static file returns the
// app shell so client-side routing can take over. API paths that land here
// (no matching route) must 404 rather than leak the SPA shell.
app.get('/*', async (c) => {
  if (c.req.path.startsWith('/api')) {
    return c.text('Not Found', 404);
  }
  try {
    const html = await readFile(indexHtmlPath, 'utf-8');
    return c.html(html);
  } catch {
    return c.text('index.html not found — run `npm run build` first.', 404);
  }
});

const logger = pino({ name: 'open-novel', level: config.logLevel });

await ensureDbReady();
initPlugins();
deploySubagents();

// Periodic DB backup — protects against crash-induced WAL corruption.
// Backups go to ./data/backups/, pruned to the 10 most recent.
startPeriodicBackup();

const server = createServer(async (req, res) => {
  try {
    // nodeRequestToFetchRequest injects the trusted `x-internal-remote-addr`
    // header from req.socket.remoteAddress (dropping any client-supplied
    // value) so rate limiting keys on the real remote address.
    const request = await nodeRequestToFetchRequest(req);
    const response = await app.fetch(request);
    await writeFetchResponse(res, response);
  } catch (err) {
    logger.error({ err }, 'request failed');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    } else {
      res.end();
    }
  }
});

server.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, `open-novel listening on http://${config.host}:${config.port}`);
});

// ── Graceful shutdown ──────────────────────────────────────────────
// Without this, SIGTERM/SIGINT kills the process before PGlite can flush
// its WAL, leaving the data directory in an inconsistent state. The next
// startup then aborts with `RuntimeError: Aborted()`.
//
// Sequence: close DB (flush WAL) → close HTTP → exit.
// We do NOT backup on shutdown — dumpDataDir is heavy and can hang during
// process teardown. Backups are handled by the periodic timer.
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return; // Second signal forces immediate exit.
  shuttingDown = true;
  logger.info({ signal }, 'shutting down…');

  // 1. Stop accepting new connections.
  server.close();

  // 2. Let PGlite flush WAL and close the data directory.
  //    Race with a timeout so a hung close cannot block shutdown forever.
  await Promise.race([
    closeDb(),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);

  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
