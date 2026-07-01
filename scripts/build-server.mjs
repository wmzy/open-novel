import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// esbuild ships as a transitive dependency (via vite). pnpm does not hoist it
// to the top-level node_modules, so resolve it through a package that is always
// present (vite is a direct devDependency).
const esbuildEntry = require.resolve('esbuild', {
  paths: [path.dirname(require.resolve('vite/package.json'))],
});
const { build } = await import(esbuildEntry);

await build({
  entryPoints: [path.join(root, 'src/server/main.ts')],
  outfile: path.join(root, 'dist/server/api.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // Keep node_modules as runtime requires (they are installed at deploy time).
  packages: 'external',
  // Defensive: a transitive server module should never import CSS, but if one
  // does, emit nothing instead of failing the build.
  loader: { '.css': 'empty', '.linaria': 'empty' },
});

console.log('✓ Server bundle written to dist/server/api.js');
