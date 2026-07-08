import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy as unknown as typeof fetch;

const { createProject, triggerRun, waitForRun, parseArgs, retryRun, importProject } =
  await import('../../../scripts/explore');

import type { ExploreOptions } from '../../../scripts/explore';

describe('explore helpers', () => {
  beforeEach(() => fetchSpy.mockReset());

  describe('createProject', () => {
    it('POSTs to /api/projects and returns { id, path }', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ project: { id: 'proj_123', path: '/tmp/r1' } }),
      });
      const result = await createProject('http://localhost:3006', {
        title: 'Route 1',
        genre: 'wuxia',
        path: '/tmp/r1',
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:3006/api/projects',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result).toEqual({ id: 'proj_123', path: '/tmp/r1' });
    });

    it('throws on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, statusText: 'Bad Request' });
      await expect(
        createProject('http://localhost:3006', { title: 'x', genre: 'x', path: '/tmp/x' }),
      ).rejects.toThrow('Bad Request');
    });
  });

  describe('triggerRun', () => {
    it('POSTs to /api/runs with autonomous:true and returns runId', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runId: 'run_abc', conversationId: 'conv_1' }),
      });
      const result = await triggerRun('http://localhost:3006', {
        projectId: 'proj_123',
        agentId: 'claude',
        stage: 'world',
        message: '推进世界构建',
        skillId: 'wuxia',
      });
      const [, opts] = fetchSpy.mock.calls[0];
      expect(JSON.parse(opts.body)).toMatchObject({
        projectId: 'proj_123',
        stage: 'world',
        autonomous: true,
      });
      expect(result).toEqual({ runId: 'run_abc', conversationId: 'conv_1' });
    });
  });

  describe('waitForRun', () => {
    it('polls /api/runs/:id/status and resolves on succeeded', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'running', pendingAskIds: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'running', pendingAskIds: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'succeeded', pendingAskIds: [] }) });
      const status = await waitForRun('http://localhost:3006', 'run_abc', { pollIntervalMs: 1 });
      expect(status).toBe('succeeded');
    });

    it('resolves on failed', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'failed', pendingAskIds: [] }) });
      const status = await waitForRun('http://localhost:3006', 'run_abc', { pollIntervalMs: 1 });
      expect(status).toBe('failed');
    });

    it('auto-answers pending elicitation', async () => {
      fetchSpy
        // first poll: running with pending ask
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'running', pendingAskIds: ['ask_1'] }) })
        // the auto-answer POST
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
        // second poll: succeeded
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'succeeded', pendingAskIds: [] }) });
      const status = await waitForRun('http://localhost:3006', 'run_abc', { pollIntervalMs: 1 });
      expect(status).toBe('succeeded');
      // verify ask was auto-answered
      const askCall = fetchSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/ask/'),
      );
      expect(askCall).toBeDefined();
    });

    it('returns failed on timeout', async () => {
      fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ status: 'running', pendingAskIds: [] }) });
      const status = await waitForRun('http://localhost:3006', 'run_abc', {
        pollIntervalMs: 1,
        timeoutMs: 5,
      });
      expect(status).toBe('failed');
    });
  });

  describe('retryRun', () => {
    it('re-POSTs to /api/runs with conversationId for retry', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runId: 'run_new', conversationId: 'conv_1' }),
      });
      const result = await retryRun('http://localhost:3006', {
        projectId: 'proj_123',
        agentId: 'claude',
        stage: 'world',
        message: '推进世界构建',
        skillId: 'wuxia',
        conversationId: 'conv_1',
      });
      const [, opts] = fetchSpy.mock.calls[0];
      expect(JSON.parse(opts.body)).toMatchObject({
        projectId: 'proj_123',
        conversationId: 'conv_1',
        autonomous: true,
      });
      expect(result).toEqual({ runId: 'run_new', conversationId: 'conv_1' });
    });
  });

  describe('importProject', () => {
    it('returns existing project when path already imported', async () => {
      // 第一次 GET 查询时已有
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ projects: [{ id: 'proj_existing', path: '/abs/my-novel' }] }),
      });
      const result = await importProject('http://localhost:3006', '/abs/my-novel');
      expect(result).toEqual({ id: 'proj_existing', path: '/abs/my-novel' });
      // 不应调 import 端点
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('imports via POST when not yet imported', async () => {
      // GET 返回空
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [] }) });
      // POST import
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ project: { id: 'proj_new', path: '/abs/new' } }),
      });
      const result = await importProject('http://localhost:3006', '/abs/new');
      expect(result).toEqual({ id: 'proj_new', path: '/abs/new' });
    });
  });

  describe('parseArgs', () => {
    it('parses seed, routes, depth', () => {
      const args = parseArgs(['--seed', '武侠失忆剑客', '--routes', '3', '--depth', 'outline']);
      expect(args.seed).toBe('武侠失忆剑客');
      expect(args.routes).toBe(3);
      expect(args.depth).toBe('outline');
    });

    it('uses defaults when minimal args', () => {
      const args = parseArgs(['--seed', '种子']);
      expect(args.routes).toBe(3);
      expect(args.depth).toBe('outline');
      expect(args.api).toBe('http://localhost:3006');
    });

    it('throws when seed missing in diverge mode', () => {
      expect(() => parseArgs([])).toThrow('seed');
    });

    it('parses single mode with project-dir', () => {
      const args = parseArgs(['--mode', 'single', '--project-dir', '/tmp/my-novel', '--depth', 'characters']);
      expect(args.mode).toBe('single');
      expect(args.projectDir).toBe('/tmp/my-novel');
      expect(args.depth).toBe('characters');
    });

    it('throws when project-dir missing in single mode', () => {
      expect(() => parseArgs(['--mode', 'single'])).toThrow('project-dir');
    });
  });
});

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const { parseConceptRoutes, buildDivergeMessage, buildExpandMessage, STAGE_ORDER, buildReport } =
  await import('../../../scripts/explore');

describe('diverge', () => {
  it('parseConceptRoutes extracts concept-route-{N}.md files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explore-'));
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
    await fs.writeFile(path.join(dir, '.novel', 'concept-route-1.md'), '# 路线1\n核心：复仇');
    await fs.writeFile(path.join(dir, '.novel', 'concept-route-2.md'), '# 路线2\n核心：救赎');
    const routes = await parseConceptRoutes(dir);
    expect(routes).toHaveLength(2);
    expect(routes[0].content).toContain('复仇');
    expect(routes[1].content).toContain('救赎');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('parseConceptRoutes returns empty array when no files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explore-'));
    const routes = await parseConceptRoutes(dir);
    expect(routes).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('buildDivergeMessage contains seed, route count, and differentiation directive', () => {
    const msg = buildDivergeMessage('武侠·失忆剑客', 3);
    expect(msg).toContain('武侠·失忆剑客');
    expect(msg).toContain('3');
    expect(msg).toContain('concept-route-1.md');
    expect(msg).toContain('实质性差异');
  });

  it('buildExpandMessage references concept seed and forbids PATCH', () => {
    const msg = buildExpandMessage('world');
    expect(msg).toContain('concept.md');
    expect(msg).toContain('不要调用 PATCH');
  });
});

describe('STAGE_ORDER', () => {
  it('orders stages from world to outline by default depth', () => {
    expect(STAGE_ORDER.outline).toEqual(['world', 'characters', 'outline']);
  });
  it('stops at world for shallow depth', () => {
    expect(STAGE_ORDER.world).toEqual(['world']);
  });
  it('includes scenes for full depth', () => {
    expect(STAGE_ORDER.scenes).toEqual(['world', 'characters', 'outline', 'scenes']);
  });
});

describe('buildReport', () => {
  const opts: ExploreOptions = {
    seed: '测试种子',
    routes: 2,
    depth: 'outline',
    api: 'http://localhost:3006',
    baseDir: '/tmp/test',
    agent: 'claude',
    skill: 'wuxia',
    pollIntervalMs: 1000,
    mode: 'diverge',
  };

  it('marks fully completed route with checkmark', () => {
    const report = buildReport(opts, [
      { index: 1, project: { id: 'p1', path: '/tmp/r1' }, stages: ['world', 'characters', 'outline'], failedAt: null, conceptSummary: '复仇线' },
    ]);
    expect(report).toContain('✅');
    expect(report).toContain('复仇线');
  });

  it('marks partially completed route with warning', () => {
    const report = buildReport(opts, [
      { index: 2, project: { id: 'p2', path: '/tmp/r2' }, stages: ['world'], failedAt: 'characters', conceptSummary: '救赎线' },
    ]);
    expect(report).toContain('⚠️');
    expect(report).toContain('characters');
  });
});
