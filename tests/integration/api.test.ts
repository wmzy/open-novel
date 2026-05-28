import { describe, it, expect } from 'vitest';

const BASE = 'http://localhost:3006/api';

describe('API Integration', () => {
  it('GET /health returns ok', async () => {
    const res = await fetch(`${BASE}/health`);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('GET /projects returns array', async () => {
    const res = await fetch(`${BASE}/projects`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it('POST /projects creates a project', async () => {
    const testDir = `/tmp/open-novel-test-${Date.now()}`;
    const res = await fetch(`${BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test Novel', genre: 'fantasy', path: testDir }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.project.title).toBe('Test Novel');
  });

  it('GET /agents returns detected agents', async () => {
    const res = await fetch(`${BASE}/agents`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.agents)).toBe(true);
  });

  it('GET /plugins returns loaded plugins', async () => {
    const res = await fetch(`${BASE}/plugins`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.plugins)).toBe(true);
  });

  it('GET / returns HTML', async () => {
    const res = await fetch('http://localhost:3006/');
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain('Open Novel');
  });
});
