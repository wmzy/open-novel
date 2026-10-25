// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RESPONSE_CHARS,
  OPEN_NOVEL_API_TOOL_NAME,
  OPEN_NOVEL_API_TIMEOUT_MS,
  createOpenNovelApiTool,
} from '../../../src/agent/pi/api-tool';

const BASE_URL = 'http://127.0.0.1:3006';
const PROJECT_ID = 'proj-1';

type ApiTool = ReturnType<typeof createOpenNovelApiTool>;
type ApiToolParams = Parameters<ApiTool['execute']>[1];

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createTool(overrides: Partial<{ baseUrl: string; token: string; projectId: string }> = {}) {
  return createOpenNovelApiTool({
    baseUrl: BASE_URL,
    projectId: PROJECT_ID,
    ...overrides,
  });
}

function run(tool: ApiTool, params: ApiToolParams) {
  return tool.execute('test-call', params, undefined, undefined, undefined as never);
}

function textOf(result: Awaited<ReturnType<ApiTool['execute']>>): string {
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('expected text tool result');
  return block.text;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function lastRequest(): [string, RequestInit] {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return fetchMock.mock.calls[0] as [string, RequestInit];
}

describe('createOpenNovelApiTool', () => {
  it('暴露 open_novel_api 工具与受限参数', () => {
    const tool = createTool();
    expect(tool.name).toBe(OPEN_NOVEL_API_TOOL_NAME);
    expect(tool.description).toContain('本地');
    expect(tool.parameters.required).toEqual(expect.arrayContaining(['method', 'path']));
    expect(OPEN_NOVEL_API_TIMEOUT_MS).toBe(30_000);
  });

  it('允许当前项目作用域的 GET 并返回 {status, body}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const result = await run(createTool(), {
      method: 'GET',
      path: `/api/projects/${PROJECT_ID}/templates/scenes?fresh=1`,
    });

    expect(result.isError).toBe(false);
    const [url, init] = lastRequest();
    expect(url).toBe(`${BASE_URL}/api/projects/${PROJECT_ID}/templates/scenes?fresh=1`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ status: 200, body: { ok: true } });
  });

  it('POST 项目子路径发送 JSON body 与 Bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }, 201));
    const tool = createTool({ baseUrl: `${BASE_URL}/`, token: 'secret-token' });
    const result = await run(tool, {
      method: 'POST',
      path: `/api/projects/${PROJECT_ID}/generate-templates`,
      body: { kind: 'outline' },
    });

    expect(result.isError).toBe(false);
    const [url, init] = lastRequest();
    expect(url).toBe(`${BASE_URL}/api/projects/${PROJECT_ID}/generate-templates`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'outline' });
    expect(JSON.parse(textOf(result))).toEqual({ status: 201, body: { ok: true } });
  });

  it('非 2xx 返回 status/body 并标记 isError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'run-in-progress' }, 409));
    const result = await run(createTool(), {
      method: 'POST',
      path: `/api/projects/${PROJECT_ID}/generate-templates`,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      status: 409,
      body: { error: 'run-in-progress' },
    });
  });

  it('超长响应截断到上限', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(MAX_RESPONSE_CHARS + 500), { status: 200 }));
    const result = await run(createTool(), { method: 'GET', path: `/api/projects/${PROJECT_ID}/templates/outline-detailed` });

    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const parsed = JSON.parse(text) as { status: number; body: string; truncated?: boolean };
    expect(parsed.status).toBe(200);
    expect(parsed.truncated).toBe(true);
    expect(parsed.body.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  });

  it('网络错误以工具结果返回而不是抛出', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const result = await run(createTool(), { method: 'GET', path: `/api/projects/${PROJECT_ID}/templates/scenes` });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('请求失败');
  });

  it.each([
    ['其他项目路径', '/api/projects/other-project/templates/scenes'],
    ['相似项目前缀', `/api/projects/${PROJECT_ID}-extra`],
    ['项目列表', '/api/projects'],
    ['绝对 URL', 'https://evil.example/api/runs'],
    ['协议相对 URL', '//evil.example/api/runs'],
    ['反斜杠路径', '/\\evil.example/api/runs'],
    ['目录穿越', `/api/projects/${PROJECT_ID}/../../api/settings`],
    ['百分号编码穿越', `/api/projects/${PROJECT_ID}/%2e%2e/api/settings`],
    ['双重编码穿越', `/api/projects/${PROJECT_ID}/%252e%252e/api/settings`],
    ['非白名单前缀', '/api/plugins'],
    ['全局 runs API', '/api/runs'],
    ['全局 settings API', '/api/settings'],
    ['前缀边界', '/api/runs-extra'],
  ])('拒绝%s', async (_label, path) => {
    const result = await run(createTool(), { method: 'GET', path });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('不允许');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
