import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3006',
    headless: true,
  },
  webServer: {
    command: 'npx vite --port 3006 --host',
    port: 3006,
    reuseExistingServer: true,
    timeout: 15000,
    // E2E suites issue many rapid requests; raise the rate-limit ceiling far
    // above the production default so tests are not throttled.
    env: {
      RATE_LIMIT_MAX: '10000',
    },
  },
});
