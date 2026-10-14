import { env } from '../../config/env.js';
import { bearerToken } from './securityGuards.js';
import { HttpError } from '../../utils/http.js';

export const SESSION_COOKIE = 'sedeagro_session';
export const WEB_SESSION_HEADER = 'x-sedeagro-session';
export const WEB_REQUEST_HEADER = 'x-sedeagro-request';
export const MAX_COOKIE_AGE = 12 * 60 * 60;

export function wantsCookieSession(req) {
  return req.headers?.[WEB_SESSION_HEADER] === 'cookie';
}

export function sessionCookie(token, { prod = env.isProd, maxAge = MAX_COOKIE_AGE } = {}) {
  return `${SESSION_COOKIE}=${token}; Path=/api; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${prod ? '; Secure' : ''}`;
}
export function clearSessionCookie({ prod = env.isProd } = {}) {
  return sessionCookie('', { prod, maxAge: 0 });
}

export function cookieToken(header) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const matches = header.split(';').map((part) => part.trim()).filter((part) =>
    part.startsWith(SESSION_COOKIE + '='));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9._-]{20,4096}$/.test(value) ? value : null;
}

export function resolveAuthToken(req) {
  if (req.headers?.authorization !== undefined) {
    return { token: bearerToken(req.headers.authorization), transport: 'bearer' };
  }
  return { token: cookieToken(req.headers?.cookie), transport: 'cookie' };
}

export function requireCookieMutationHeader(req) {
  if (req.authTransport !== 'cookie' ||
      ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers?.[WEB_REQUEST_HEADER] !== '1') {
    throw new HttpError(403, 'Encabezado de protección de sesión requerido.', undefined, 'CSRF_HEADER_REQUIRED');
  }
}
