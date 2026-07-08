import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy as unknown as typeof fetch;

const { createProject, triggerRun, waitForRun, parseArgs, retryRun } =
  await import('../../../scripts/explore');

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

    it('throws when seed missing', () => {
      expect(() => parseArgs([])).toThrow('seed');
    });
  });
});
