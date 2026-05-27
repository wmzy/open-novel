import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import wyw from '@wyw-in-js/vite';
import path from 'node:path';

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
        const url = new URL(`/api${req.url || '/'}`, `http://${req.headers.host}`);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const body = req.method !== 'GET' && req.method !== 'HEAD'
          ? await new Promise<Buffer>((resolve) => {
              const chunks: Buffer[] = [];
              req.on('data', (chunk: Buffer) => chunks.push(chunk));
              req.on('end', () => resolve(Buffer.concat(chunks)));
            })
          : undefined;
        const request = new Request(url.toString(), {
          method: req.method,
          headers,
          body,
        });
        const response = await app.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const reader = response.body.getReader();
          const pump = async () => {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            res.write(value);
            await pump();
          };
          await pump();
        } else {
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), wyw(), honoApiPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: './dist/client',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          router: ['react-router-dom'],
        },
      },
    },
  },
  server: {
    port: 3000,
  },
  ssr: {
    noExternal: ['hono'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
});
