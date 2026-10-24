/**
 * Application configuration from environment variables.
 */

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3006', 10),
  // 默认只监听回环地址：本应用可读写项目文件、触发 AI 调用、删除项目/恢复备份，
  // 暴露到局域网等于把这些能力交给任何能连上端口的人。需要局域网访问时显式
  // 设置 HOST=0.0.0.0，并强烈建议同时设置 AUTH_TOKEN（见 src/api/middleware/auth.ts）。
  host: process.env.HOST || '127.0.0.1',

  // 可选访问令牌。设置后所有 /api/*（含 SSE）都需要 Bearer / 登录 Cookie / 一次性 ?token=。
  // 未设置时保持本地单机使用的旧行为；HOST 非回环且未设置时启动会打印安全警告。
  auth: {
    token: process.env.AUTH_TOKEN?.trim() || undefined,
  },

  // Agent paths
  agentPaths: {
    claude: process.env.CLAUDE_PATH || 'claude',
    opencode: process.env.OPENCODE_PATH || 'opencode',
  },

  // Database
  db: {
    url: process.env.DATABASE_URL,
  },

  // Rate limiting (requests per window per client IP)
  rateLimit: {
    max: parseInt(process.env.RATE_LIMIT_MAX || '200', 10),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  },

  // Agent subprocess timeout (ms). Default 30 minutes; overridable via AGENT_TIMEOUT_MS.
  agent: {
    timeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS || '1800000', 10),
    // 提问（elicitation）最长挂起时长（ms）。挂起期间超时计时暂停、用户思考不计入，
    // 但提问本身不能无限挂起——过期自动取消整个 run（agent 不再带着缺省答案继续写盘），
    // 防止 run 与项目串行锁被永久占用。默认 24 小时；可经 ASK_TIMEOUT_MS 覆盖。
    askTimeoutMs: parseInt(process.env.ASK_TIMEOUT_MS || '86400000', 10),
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
} as const;
