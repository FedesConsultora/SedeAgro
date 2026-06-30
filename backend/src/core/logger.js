import { env } from '../config/env.js';

const sensitiveKeys = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'password_hash',
  'new_password',
  'old_password',
  'token',
  'refresh_token',
  'access_token',
  'csrf',
  'secret',
  'credentials'
];

const levelWeight = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

function shouldLog(level) {
  const configured = env.logLevel || (env.isProd ? 'info' : 'debug');
  return levelWeight[level] >= levelWeight[configured];
}

function isSensitiveKey(key = '') {
  const normalized = key.toLowerCase();
  return sensitiveKeys.some((sensitive) => normalized.includes(sensitive));
}

export function redact(value, depth = 0) {
  if (depth > 5) return '[Truncated]';
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(env.logStack ? { stack: value.stack } : {})
    };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    isSensitiveKey(key) ? '[REDACTED]' : redact(entry, depth + 1)
  ]));
}

function getLevelColor(level) {
  const colors = {
    debug: '\x1b[36m', // Cyan
    info: '\x1b[32m',  // Green
    warn: '\x1b[33m',  // Yellow
    error: '\x1b[31m'  // Red
  };
  return colors[level] || '\x1b[0m';
}

function serialize(level, event, meta = {}) {
  const redacted = redact(meta);
  if (env.logFormat === 'text') {
    const timestamp = new Date().toLocaleTimeString('es-AR', { hour12: false });
    const color = getLevelColor(level);
    const reset = '\x1b[0m';
    
    // Core details
    let message = `[${timestamp}] ${color}${level.toUpperCase()}${reset} | ${event}`;
    
    // Request details if present
    if (event === 'http.request') {
      const statusColor = redacted.status >= 500 ? '\x1b[31m' : redacted.status >= 400 ? '\x1b[33m' : '\x1b[32m';
      message = `[${timestamp}] ${color}HTTP${reset} | ${redacted.method} ${redacted.path} -> ${statusColor}${redacted.status}${reset} (${redacted.duration_ms}ms) | IP: ${redacted.ip}`;
    } else if (event === 'http.handled_error' || event === 'http.unhandled_error') {
      message += ` -> \x1b[31mError ${redacted.status}: ${redacted.message || 'Error no controlado'}\x1b[0m`;
    }

    // Append extra details if any
    const extraKeys = Object.keys(redacted).filter(k => !['request_id', 'method', 'path', 'status', 'duration_ms', 'ip', 'user_agent', 'message'].includes(k));
    if (extraKeys.length > 0) {
      const extraMeta = Object.fromEntries(extraKeys.map(k => [k, redacted[k]]));
      message += ` | details: ${JSON.stringify(extraMeta)}`;
    }
    return message;
  }

  return JSON.stringify(redact({
    at: new Date().toISOString(),
    service: 'sedeagro-backend',
    env: env.nodeEnv,
    level,
    event,
    ...meta
  }));
}

function write(level, event, meta) {
  if (!shouldLog(level)) return;
  const line = serialize(level, event, meta);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug(event, meta = {}) {
    write('debug', event, meta);
  },
  info(event, meta = {}) {
    write('info', event, meta);
  },
  warn(event, meta = {}) {
    write('warn', event, meta);
  },
  error(event, meta = {}) {
    write('error', event, meta);
  },
  child(defaultMeta = {}) {
    return {
      debug: (event, meta = {}) => logger.debug(event, { ...defaultMeta, ...meta }),
      info: (event, meta = {}) => logger.info(event, { ...defaultMeta, ...meta }),
      warn: (event, meta = {}) => logger.warn(event, { ...defaultMeta, ...meta }),
      error: (event, meta = {}) => logger.error(event, { ...defaultMeta, ...meta })
    };
  }
};
