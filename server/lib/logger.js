/**
 * Simple Logger Utility
 * Provides leveled logging with timestamps
 */

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLogLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? LOG_LEVELS.info;

const logger = {
  _format: (level, message, meta) => {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  },
  error: (message, meta) => {
    if (currentLogLevel >= LOG_LEVELS.error) {
      console.error(logger._format('error', message, meta));
    }
  },
  warn: (message, meta) => {
    if (currentLogLevel >= LOG_LEVELS.warn) {
      console.warn(logger._format('warn', message, meta));
    }
  },
  info: (message, meta) => {
    if (currentLogLevel >= LOG_LEVELS.info) {
      console.log(logger._format('info', message, meta));
    }
  },
  debug: (message, meta) => {
    if (currentLogLevel >= LOG_LEVELS.debug) {
      console.log(logger._format('debug', message, meta));
    }
  }
};

module.exports = logger;
