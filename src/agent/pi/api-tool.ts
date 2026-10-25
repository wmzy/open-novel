/**
 * Pi 自定义工具：受限地调用本机 open-novel HTTP API。
 *
 * 替代「让 agent 用 bash + curl 调本地 API」：模型只能访问当前项目作用域
 * （/api/projects/{projectId}）以及 /api/runs、/api/agents、/api/settings，
 * 并且只允许相对路径；绝对 URL、外部主机、目录穿越一律拒绝。
 * 所有失败（含参数校验、网络错误、非 2xx）都以工具结果文本返回，不抛到 agent loop 外。
 */
import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';

export interface OpenNovelApiToolOptions {
  /** 例如 http://127.0.0.1:3006 */
  baseUrl: string;
  /** 可选 Bearer token */
  token?: string;
  /** 当前项目 id；只允许访问该项目作用域 */
  projectId: string;
}

export const OPEN_NOVEL_API_TOOL_NAME = 'open_novel_api';

/** 单次请求超时（毫秒）。 */
export const OPEN_NOVEL_API_TIMEOUT_MS = 30_000;

/** 返回给模型的响应文本上限（字符）。 */
export const MAX_RESPONSE_CHARS = 20_000;

const PROJECTS_ROOT = '/api/projects';

interface NormalizedBaseUrl {
  /** 去掉尾部斜杠的 base（可含挂载前缀），用于拼接相对 path。 */
  url: string;
  origin: string;
}

function normalizeBaseUrl(raw: string): NormalizedBaseUrl | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return { url: `${parsed.origin}${pathname}`, origin: parsed.origin };
  } catch {
    return null;
  }
}

/** 前缀匹配要求边界是 `/`、`?` 或结尾，避免 `/api/runsfoo` 混进 `/api/runs`。 */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isAllowedApiPath(pathname: string, projectId: string): boolean {
  return matchesPrefix(pathname, `${PROJECTS_ROOT}/${projectId}`);
}

function resolveApiUrl(
  rawPathValue: string,
  projectId: string,
  base: NormalizedBaseUrl,
): { url: string } | { error: string } {
  const rawPath = rawPathValue.trim();
  if (!rawPath) return { error: 'path 不能为空。' };
  if (!rawPath.startsWith('/')) {
    return { error: 'path 必须是以 / 开头的相对路径；不允许使用绝对 URL（如 http://...）。' };
  }
  if (rawPath.startsWith('//')) {
    return { error: '不允许使用协议相对 URL（//host/...）访问外部主机。' };
  }
  if (rawPath.includes('\\')) return { error: 'path 中不允许包含反斜杠。' };
  if (rawPath.includes('#')) return { error: 'path 中不允许包含 URL fragment（#）。' };
  if (hasControlChars(rawPath)) {
    return { error: 'path 中不允许包含控制字符或换行。' };
  }

  const queryIndex = rawPath.indexOf('?');
  const rawPathname = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : rawPath.slice(queryIndex);

  if (rawPathname.includes('..')) {
    return { error: 'path 中不允许包含 ".."（禁止目录穿越）。' };
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(rawPathname);
  } catch {
    return { error: 'path 含有非法的百分号编码。' };
  }
  if (decodedPathname.includes('..') || decodedPathname.includes('\\')) {
    return { error: 'path 中不允许包含 ".." 或反斜杠（禁止目录穿越）。' };
  }
  // 双重编码（%252e%252e）同样视为目录穿越。
  let doubleDecoded = decodedPathname;
  try {
    doubleDecoded = decodeURIComponent(decodedPathname);
  } catch {
    // 单次解码结果已可用；无法再解码时保持原样。
  }
  if (doubleDecoded.includes('..') || doubleDecoded.includes('\\')) {
    return { error: 'path 中不允许包含 ".." 或反斜杠（禁止目录穿越）。' };
  }
  if (decodedPathname.startsWith('//')) {
    return { error: '不允许使用协议相对 URL（//host/...）访问外部主机。' };
  }

  if (!isAllowedApiPath(decodedPathname, projectId)) {
    if (decodedPathname === PROJECTS_ROOT || matchesPrefix(decodedPathname, PROJECTS_ROOT)) {
      return {
        error: `不允许访问其他项目的 API：${decodedPathname}。当前工具只能访问项目 ${projectId}。`,
      };
    }
    return {
      error:
        `不允许访问该 API 路径：${decodedPathname}。只允许 /api/projects/${projectId} 及其子路径。`,
    };
  }

  let target: URL;
  try {
    target = new URL(`${base.url}${rawPathname}${rawQuery}`);
  } catch {
    return { error: '无法解析目标 URL。' };
  }
  if (target.origin !== base.origin) {
    return { error: '不允许访问外部主机。' };
  }
  if (target.username || target.password) {
    return { error: '不允许在 URL 中携带凭据。' };
  }
  return { url: target.toString() };
}

/** 把 HTTP 响应压成 `{status, body}` JSON 文本；超长响应截断后标记 truncated。 */
function formatApiResponse(status: number, rawText: string): string {
  let truncated = rawText.length > MAX_RESPONSE_CHARS;
  const source = truncated ? rawText.slice(0, MAX_RESPONSE_CHARS) : rawText;

  let body: unknown = source;
  if (!truncated) {
    try {
      body = JSON.parse(source);
    } catch {
      body = source;
    }
  }

  const wrap = (value: unknown): string =>
    JSON.stringify(truncated ? { status, body: value, truncated: true } : { status, body: value });

  let text = wrap(body);
  if (text.length <= MAX_RESPONSE_CHARS) return text;

  // 极端情况下引号/控制字符的 JSON 转义会放大长度：退化为纯文本并逐步裁剪。
  truncated = true;
  let budget = source.length;
  while (text.length > MAX_RESPONSE_CHARS && budget > 0) {
    budget = Math.max(0, budget - 1_000);
    text = wrap(source.slice(0, budget));
  }
  return text;
}

function describeRequestError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return `请求超时（${OPEN_NOVEL_API_TIMEOUT_MS / 1_000} 秒）。`;
    }
    if (error.name === 'AbortError') return '请求已取消。';
    return `请求失败：${error.message}`;
  }
  return `请求失败：${String(error)}`;
}

function combineSignals(outer: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(OPEN_NOVEL_API_TIMEOUT_MS);
  if (!outer) return timeout;
  return AbortSignal.any([outer, timeout]);
}

function textResult(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

export function createOpenNovelApiTool(options: OpenNovelApiToolOptions) {
  const base = normalizeBaseUrl(options.baseUrl);
  const projectId = options.projectId.trim();

  return defineTool({
    name: OPEN_NOVEL_API_TOOL_NAME,
    label: 'Open-Novel API',
    description:
      '调用本机 open-novel 的 HTTP API，用于阶段推进（PATCH /api/projects/{projectId}）、' +
      '模板生成（POST /api/projects/{projectId}/generate-templates）、质量检查' +
      '（POST /api/projects/{projectId}/check/*）等本地操作。path 必须是相对路径，且只能访问' +
      `当前项目 /api/projects/${projectId} 及其子路径。` +
      '本工具仅用于本地 open-novel 服务；不要用它访问外部网络，也不要传绝对 URL 或其他项目路径。',
    promptSnippet: 'Call the local open-novel HTTP API (project-scoped)',
    parameters: Type.Object({
      method: Type.Union([
        Type.Literal('GET'),
        Type.Literal('POST'),
        Type.Literal('PATCH'),
      ]),
      path: Type.String({
        description:
          '相对路径，例如 /api/projects/{projectId}/generate-templates 或 /api/projects/{projectId}/check/ai-patterns；' +
          '不得是绝对 URL，不得包含 ..',
      }),
      body: Type.Optional(
        Type.Unknown({
          description: 'JSON 请求体（POST/PATCH/DELETE 使用；GET 会忽略 body）。',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (!base) {
        return textResult('open_novel_api 配置错误：baseUrl 不是合法的 http(s) URL。', true);
      }
      if (!projectId) {
        return textResult('open_novel_api 配置错误：缺少 projectId，无法限定项目作用域。', true);
      }

      const resolved = resolveApiUrl(params.path, projectId, base);
      if ('error' in resolved) {
        return textResult(resolved.error, true);
      }

      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (options.token) headers.Authorization = `Bearer ${options.token}`;

        const init: RequestInit = {
          method: params.method,
          headers,
          redirect: 'error',
          signal: combineSignals(signal),
        };
        if (params.body !== undefined && params.method !== 'GET') {
          headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(params.body);
        }

        const response = await fetch(resolved.url, init);
        const text = await response.text();
        const isError = response.status < 200 || response.status >= 300;
        return textResult(formatApiResponse(response.status, text), isError);
      } catch (error) {
        return textResult(describeRequestError(error), true);
      }
    },
  });
}
