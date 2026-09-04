/**
 * Application configuration from environment variables.
 */

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3006', 10),
  host: process.env.HOST || '0.0.0.0',

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
    // 但提问本身不能无限挂起——过期自动取消，防止 run 与项目串行锁被永久占用。
    // 默认 24 小时；可经 ASK_TIMEOUT_MS 覆盖。
    askTimeoutMs: parseInt(process.env.ASK_TIMEOUT_MS || '86400000', 10),
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
} as const;
