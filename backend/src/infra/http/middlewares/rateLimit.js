import { HttpError } from '../../../utils/http.js';

const buckets = new Map();

function clientKey(req, keyPrefix) {
  return `${keyPrefix}:${req.ip}:${req.body?.email || ''}`;
}

export function rateLimit({ windowMs, max, keyPrefix = 'default' }) {
  return (req, _res, next) => {
    const now = Date.now();
    const key = clientKey(req, keyPrefix);
    const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };

    if (bucket.resetAt <= now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count > max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      return next(new HttpError(429, `Demasiados intentos. Probá de nuevo en ${retryAfterSeconds} segundos.`, {
        retryAfterSeconds
      }, 'RATE_LIMITED'));
    }

    next();
  };
}
