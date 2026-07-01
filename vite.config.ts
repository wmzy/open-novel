import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import wyw from '@wyw-in-js/vite';
import path from 'node:path';
import { nodeRequestToFetchRequest, writeFetchResponse } from './src/server/request-adapter';

function honoApiPlugin() {
  return {
    name: 'hono-api',
    configureServer(server: any) {
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
