import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../../utils/http.js';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
export const DEFAULT_EVIDENCE_PAGE_LIMIT = 100;
export const MAX_EVIDENCE_PAGE_LIMIT = 100;

function invalidCursor() {
  throw new HttpError(400, 'Cursor de evidencias inválido o vencido.', undefined, 'EVIDENCE_CURSOR_INVALID');
}

function sign(body, secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('No se configuró una clave de servidor segura para los cursores.');
  }
  return createHmac('sha256', secret).update(body).digest('base64url');
}

// The only trusted keyset boundary is a signed cursor bound to exactly the
// authorized tenant/run and requested page size. No user-controlled offset,
// SQL identifiers, column names or arbitrary timestamps reach the query.
export function encodeEvidencePageCursor(row, { tenantId, runId, limit, secret = process.env.JWT_SECRET }) {
  const date = row?.created_at instanceof Date ? row.created_at : new Date(row?.created_at);
  if (!UUID.test(row?.id ?? '') || !UUID.test(tenantId) || !UUID.test(runId) ||
      !Number.isInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_PAGE_LIMIT ||
      !Number.isFinite(date.getTime())) throw new Error('No se puede crear un cursor de evidencia inválido.');
  const payload = {
    v: 1, tenantId, runId, limit,
    createdAt: date.toISOString(), id: row.id
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function decodeEvidencePageCursor(token, { tenantId, runId, limit, secret = process.env.JWT_SECRET }) {
  if (typeof token !== 'string' || token.length > 640 || !TOKEN.test(token)) invalidCursor();
  const [body, mac] = token.split('.');
  const expected = sign(body, secret);
  const provided = Buffer.from(mac, 'base64url');
  if (provided.length !== 32 || !timingSafeEqual(provided, Buffer.from(expected, 'base64url'))) invalidCursor();
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    invalidCursor();
  }
  if (!cursor || Object.keys(cursor).sort().join(',') !==
        ['v', 'tenantId', 'runId', 'limit', 'createdAt', 'id'].sort().join(',') ||
      cursor.v !== 1 || cursor.tenantId !== tenantId || cursor.runId !== runId ||
      cursor.limit !== limit || !UUID.test(cursor.id || '') ||
      typeof cursor.createdAt !== 'string' || !ISO.test(cursor.createdAt) ||
      !Number.isFinite(Date.parse(cursor.createdAt)) ||
      new Date(cursor.createdAt).toISOString() !== cursor.createdAt) invalidCursor();
  return { date: new Date(cursor.createdAt), id: cursor.id };
}

export function parseEvidencePageQuery(query, { tenantId, runId, secret = process.env.JWT_SECRET }) {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(k => !['limit', 'cursor'].includes(k))) {
    throw new HttpError(400, 'Parámetros de evidencia inválidos.', undefined, 'EVIDENCE_QUERY_INVALID');
  }
  const raw = query.limit;
  const limit = raw === undefined ? DEFAULT_EVIDENCE_PAGE_LIMIT :
    typeof raw === 'string' && /^(?:[1-9]|[1-9][0-9]|100)$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_PAGE_LIMIT) {
    throw new HttpError(400, 'Límite de evidencias inválido.', undefined, 'EVIDENCE_LIMIT_INVALID');
  }
  return {
    limit,
    after: query.cursor === undefined ? null :
      decodeEvidencePageCursor(query.cursor, { tenantId, runId, limit, secret })
  };
}
