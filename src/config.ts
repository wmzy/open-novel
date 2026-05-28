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

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Features
  features: {
    autoSave: process.env.FEATURE_AUTO_SAVE !== 'false',
    snapshots: process.env.FEATURE_SNAPSHOTS !== 'false',
    fileWatching: process.env.FILE_WATCHING !== 'false',
  },
} as const;
