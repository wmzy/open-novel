import { toast } from 'sonner';

/**
 * 可选令牌认证的前端提示。
 *
 * 服务端设置 AUTH_TOKEN 后，未登录的 fetch/React Query 请求会得到 401。
 * 各处页面原本只显示空数据，用户无从知道原因；这里统一拦截一次 window.fetch，
 * 用已有 toast（sonner）给出登录指引，并保持单例避免重复弹窗。
 *
 * EventSource 无法附加请求头，登录后由浏览器自动携带 HttpOnly Cookie，
 * 因此这里的提示只负责引导用户完成一次性登录。
 */

const AUTH_TOAST_ID = 'auth-required';
let installed = false;

export function notifyAuthRequired(): void {
  toast.error('需要访问令牌', {
    id: AUTH_TOAST_ID,
    description:
      '服务已启用 AUTH_TOKEN。请在浏览器打开 /api/health?token=<你的 AUTH_TOKEN> 完成一次性登录，然后刷新页面。',
    duration: Infinity,
  });
}

export function installAuthNotice(): void {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    if (response.status === 401) notifyAuthRequired();
    return response;
  };
}
