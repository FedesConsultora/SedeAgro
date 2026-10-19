import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

export const REVIEW_CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_VERSION = 2;
export const REVIEW_QUEUE_WORK_TYPES = Object.freeze([
  'all', 'application', 'sowing', 'fertilization', 'harvest',
  'irrigation', 'inspection', 'other'
]);
const isValidWorkType = value => REVIEW_QUEUE_WORK_TYPES.includes(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const signature = bytes => createHmac('sha256', env.jwtSecret)
  .update('sedeagro:review-queue:v2:').update(bytes).digest();

export class ReviewCursorError extends Error {
  constructor(message = 'Cursor de revisión inválido o vencido.') {
    super(message);
    this.code = 'ORDER_REVIEW_CURSOR_INVALID';
  }
}

function validatePayload(value, tenantId, userId, workType, nowMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'a,e,i,t,u,v,w' ||
    value.v !== CURSOR_VERSION || value.t !== tenantId || value.u !== userId ||
    !isValidWorkType(workType) || value.w !== workType ||
    !UUID.test(value.t) || !UUID.test(value.u) || !UUID.test(value.i) ||
    !ISO.test(value.a) || !ISO.test(value.e)) throw new ReviewCursorError();
  const anchor = Date.parse(value.a);
  const expires = Date.parse(value.e);
  if (!Number.isFinite(anchor) || !Number.isFinite(expires) ||
    expires <= anchor || expires - anchor > REVIEW_CURSOR_TTL_MS ||
    anchor > nowMs + 5000 || nowMs >= expires) throw new ReviewCursorError();
  // A cursor only moves backwards within the fixed snapshot anchor.
  return value;
}

export function issueReviewCursor({ tenantId, userId, workType = 'all', anchor, last }, nowMs = Date.now()) {
  if (!isValidWorkType(workType)) throw new ReviewCursorError();
  const date = anchor instanceof Date ? anchor : new Date(anchor);
  const lastTime = last.created_at instanceof Date ? last.created_at : new Date(last.created_at);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(lastTime.getTime()) ||
      lastTime.getTime() > date.getTime()) throw new ReviewCursorError();
  const payload = { v: CURSOR_VERSION, t: tenantId, u: userId, w: workType,
    a: date.toISOString(), e: new Date(date.getTime() + REVIEW_CURSOR_TTL_MS).toISOString(),
    i: last.id };
  // Include the last ordered tuple; ISO encodes the PostgreSQL timestamp to ms.
  // DB values are truncated to milliseconds consistently at the API boundary.
  payload.l = lastTime.toISOString();
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signature(body).toString('base64url')}`;
}

export function parseReviewCursor(token, { tenantId, userId, workType = 'all' }, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024 ||
      !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(token)) throw new ReviewCursorError();
  const [body, mac] = token.split('.');
  const expected = signature(body);
  const provided = Buffer.from(mac, 'base64url');
  if (mac !== expected.toString('base64url') || provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)) {
    throw new ReviewCursorError();
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { throw new ReviewCursorError(); }
  if (!parsed || !ISO.test(parsed.l) ||
    !UUID.test(parsed.i) || !Number.isFinite(Date.parse(parsed.l)) ||
    Date.parse(parsed.l) > Date.parse(parsed.a) ||
    Object.keys(parsed).sort().join(',') !== 'a,e,i,l,t,u,v,w') throw new ReviewCursorError();
  const { l, ...base } = parsed;
  validatePayload(base, tenantId, userId, workType, nowMs);
  return { anchor: new Date(parsed.a), lastDate: new Date(l), lastId: parsed.i, workType: parsed.w };
}
