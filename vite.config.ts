import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import wyw from '@wyw-in-js/vite';
import path from 'node:path';
import { nodeRequestToFetchRequest, writeFetchResponse } from './src/server/request-adapter';

// NOTE: Do NOT import src/db/drizzle or src/db/backup at the top level!
//
// vitest loads this config file BEFORE tests/setup.ts runs. setup.ts sets
// PGLITE_DATA_DIR to an isolated temp dir. If drizzle.ts is imported here,
// its module-level singleton `createDb()` would run immediately — reading
// PGLITE_DATA_DIR before setup.ts sets it — and bind PGlite to the live
// ./data/pglite directory. That is the exact root cause of the database
// corruption bug: vitest's main process and the dev server would write to
// the same data directory concurrently.
//
// All DB imports must be dynamic (await import(...)) inside configureServer,
// which vitest never calls.

function honoApiPlugin() {
  return {
    name: 'hono-api',
    configureServer(server: any) {
      // Initialise the database eagerly when the Vite dev server starts.
      // In production this is done by src/server/main.ts.
      //
      // Dynamic import is CRITICAL: vitest parses vite.config.ts before
      // tests/setup.ts runs. If drizzle.ts were a static import, its
      // module-level singleton would bind to ./data/pglite (the dev store)
      // before setup.ts can redirect PGLITE_DATA_DIR to a temp dir.
      //
      // We cache the shutdown functions at startup so that the SIGTERM
      // handler does not need to perform a dynamic import while Vite is
      // tearing down its module graph (which would hang).
      let _closeDb: (() => Promise<void>) | null = null;
      void (async () => {
        try {
          const { ensureDbReady, closeDb } = await import('./src/db/drizzle.ts');
          const { startPeriodicBackup } = await import('./src/db/backup.ts');
          const { initPlugins } = await import('./src/plugins/registry.ts');
          _closeDb = closeDb;
          await ensureDbReady();
          initPlugins();
          startPeriodicBackup();
        } catch (err) {
          console.error('[hono-api] DB init failed:', err);
        }
      })();

      server.middlewares.use('/api', async (req: any, res: any) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          });
          res.end();
          return;
        }
        const { default: app } = await import('./src/api-app.ts');
        // Re-attach the '/api' prefix stripped by the connect mount point, and
        // inject the trusted remote-addr header from the socket.
        const request = await nodeRequestToFetchRequest(req, '/api');
        const response = await app.fetch(request);
        await writeFetchResponse(res, response);
      });

      // Graceful shutdown: flush PGlite WAL.
      // Without this, Ctrl-C kills Vite before PGlite can close, leaving
      // the data directory corrupted.
      //
      // IMPORTANT: We do NOT run backupOnShutdown here. dumpDataDir() is a
      // heavy operation that coordinates with the running Postgres WAL,
      // and during Vite teardown the wasm runtime can hang indefinitely.
      // Backup is handled by the periodic timer + a manual API endpoint.
      // The critical action on shutdown is closeDb() which flushes WAL.
      //
      // Functions are cached at startup (_closeDb) to avoid dynamic
      // imports during teardown, which race with Vite's module graph.
      let shuttingDown = false;
      async function gracefulShutdown(signal: string) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.info(`[hono-api] ${signal} received, shutting down…`);
        if (_closeDb) {
          try {
            await Promise.race([
              _closeDb(),
              new Promise<void>((resolve) => setTimeout(resolve, 5000)),
            ]);
            console.info('[hono-api] DB closed');
          }
          catch (err) { console.error('[hono-api] DB close failed:', err); }
        }
        process.exit(0);
      }
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    },
  };
}

export default defineConfig({
  plugins: [
    react({ exclude: ['node_modules/**'] }),
    wyw({
      sourceMap: process.env.NODE_ENV !== 'production',
      displayName: process.env.NODE_ENV !== 'production',
      exclude: ['node_modules/**'],
      evaluate: false,
    }),
    honoApiPlugin(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: './dist/client',
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 3006,
    host: true,
  },
  ssr: {
    noExternal: ['hono'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
  },
});
