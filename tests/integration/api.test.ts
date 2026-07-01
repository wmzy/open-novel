import { describe, it, expect, beforeAll } from 'vitest';
import app from '../../src/api-app';
import { ensureDbReady } from '../../src/db/drizzle';
import { initPlugins } from '../../src/plugins/registry';

describe('API Integration', () => {
  beforeAll(async () => {
    await ensureDbReady();
    initPlugins();
  });

  it('GET /api/health returns ok', async () => {
    const res = await app.request('/api/health');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('GET /api/projects returns array', async () => {
    const res = await app.request('/api/projects');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it('POST /api/projects creates a project', async () => {
    const testDir = `/tmp/open-novel-test-${Date.now()}`;
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test Novel', genre: 'fantasy', path: testDir }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.project.title).toBe('Test Novel');
  });

  it('GET /api/agents returns detected agents', async () => {
    const res = await app.request('/api/agents');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.agents)).toBe(true);
  });

  it('GET /api/plugins returns loaded plugins', async () => {
    const res = await app.request('/api/plugins');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.plugins)).toBe(true);
  });

  it('GET /api/unknown returns 404', async () => {
    // The API app does not serve a root '/' route (the HTML shell is delivered
    // by Vite/static hosting). Verify the API routing contract instead: an
    // unmatched /api path yields a 404 rather than a false 200.
    const res = await app.request('/api/this-route-does-not-exist');
    expect(res.status).toBe(404);
  });
});
