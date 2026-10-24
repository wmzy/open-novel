import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  AUTH_COOKIE_NAME,
  createAuthMiddleware,
  isLoopbackHost,
  timingSafeEqualStrings,
} from '../../../src/api/middleware/auth';
import { onError } from '../../../src/api/middleware/error-handler';

/**
 * 可选令牌认证（AUTH_TOKEN）的单元测试。
 *
 * 用 createAuthMiddleware 注入令牌，避免依赖进程环境变量；api-app 中的默认
 * 实例只是 `() => config.auth.token`，行为完全一致。
 */

const TOKEN = 'test-secret-token-123';

function makeApp(token: string | undefined) {
  const app = new Hono();
  app.onError(onError);
  app.use('/api/*', createAuthMiddleware(() => token));
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.get('/api/projects', (c) => c.json({ ok: true }));
  // 模拟 SSE：EventSource 不能带自定义头，只能靠 Cookie。
  app.get('/api/projects/:id/events', (c) => {
    c.header('Content-Type', 'text/event-stream');
    return c.body('data: hello\n\n');
  });
  app.get('/', (c) => c.text('static'));
  return app;
}

describe('optional API token auth', () => {
  describe('AUTH_TOKEN 未设置', () => {
    it('API 完全开放（保持本地单机旧行为）', async () => {
      const app = makeApp(undefined);
      expect((await app.request('/api/projects')).status).toBe(200);
      expect((await app.request('/api/projects/p1/events')).status).toBe(200);
      expect((await app.request('/')).status).toBe(200);
    });
  });

  describe('AUTH_TOKEN 已设置', () => {
    it('无凭证返回 401（UnauthorizedError 语义）', async () => {
      const app = makeApp(TOKEN);
      const res = await app.request('/api/projects');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe('UNAUTHORIZED');
      expect(body.error).toContain('认证失败');
    });

    it('Authorization: Bearer 通过', async () => {
      const app = makeApp(TOKEN);
      const res = await app.request('/api/projects', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
    });

    it('Bearer 大小写不敏感，但令牌错误仍 401', async () => {
      const app = makeApp(TOKEN);
      expect(
        (await app.request('/api/projects', {
          headers: { Authorization: `bearer ${TOKEN}` },
        })).status,
      ).toBe(200);
      expect(
        (await app.request('/api/projects', {
          headers: { Authorization: 'Bearer wrong-token' },
        })).status,
      ).toBe(401);
    });

    it('登录 Cookie 通过', async () => {
      const app = makeApp(TOKEN);
      const res = await app.request('/api/projects', {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` },
      });
      expect(res.status).toBe(200);
    });

    it('错误 Cookie / 长度不同的令牌返回 401', async () => {
      const app = makeApp(TOKEN);
      const res = await app.request('/api/projects', {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=short` },
      });
      expect(res.status).toBe(401);
    });

    it('SSE 流同样受保护，携带 Cookie 可建立', async () => {
      const app = makeApp(TOKEN);
      const denied = await app.request('/api/projects/p1/events');
      expect(denied.status).toBe(401);

      const allowed = await app.request('/api/projects/p1/events', {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('content-type')).toContain('text/event-stream');
    });

    it('静态资源与 /api/health 保持开放', async () => {
      const app = makeApp(TOKEN);
      expect((await app.request('/')).status).toBe(200);
      expect((await app.request('/api/health')).status).toBe(200);
    });

    it('?token= 一次性登录：设置 HttpOnly Cookie 并重定向，且剥离查询参数', async () => {
      const app = makeApp(TOKEN);
      const res = await app.request(`/api/projects?keep=1&token=${TOKEN}`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/api/projects?keep=1');

      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(`${AUTH_COOKIE_NAME}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');

      // 登录后浏览器自动携带的 Cookie 可用于后续请求。
      const cookie = setCookie.split(';')[0];
      expect((await app.request('/api/projects', { headers: { Cookie: cookie } })).status).toBe(200);
    });

    it('?token= 对 /api/health 也可用作登录入口', async () => {
      const app = makeApp(TOKEN);
      const res = await app.request(`/api/health?token=${TOKEN}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/api/health');
      expect(res.headers.get('set-cookie')).toContain(AUTH_COOKIE_NAME);
    });

    it('错误的 ?token= 返回 401 且不下发 Cookie', async () => {
      const app = makeApp(TOKEN);
      const res = await app.request('/api/projects?token=wrong');
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('timingSafeEqualStrings', () => {
    it('相同字符串为 true，不同内容/不同长度为 false', () => {
      expect(timingSafeEqualStrings('abc', 'abc')).toBe(true);
      expect(timingSafeEqualStrings('abc', 'abd')).toBe(false);
      expect(timingSafeEqualStrings('abc', 'abcd')).toBe(false);
      expect(timingSafeEqualStrings('', 'a')).toBe(false);
    });
  });

  describe('isLoopbackHost', () => {
    it('识别回环地址与非回环地址', () => {
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('127.0.0.2')).toBe(true);
      expect(isLoopbackHost('localhost')).toBe(true);
      expect(isLoopbackHost('::1')).toBe(true);
      expect(isLoopbackHost('[::1]')).toBe(true);
      expect(isLoopbackHost('0.0.0.0')).toBe(false);
      expect(isLoopbackHost('::')).toBe(false);
      expect(isLoopbackHost('192.168.1.5')).toBe(false);
    });
  });
});
