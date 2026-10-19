export const REVIEW_MODERATION_PATH = '/work-orders/review-queue/views/moderation';
export const MODERATION_REASON_MAX = 200;
export const MODERATION_AUDIT_LIMIT = 50;
export const MODERATION_VIEW_LIMIT = 20;

export function normalizeModerationReason(value) {
  if (typeof value !== 'string') throw new Error('Motivo inválido.');
  const reason=value.normalize('NFC').trim().replace(/\s+/gu,' ');
  if (reason.length < 8 || reason.length > MODERATION_REASON_MAX ||
      /[\p{Cc}\p{Cf}]/u.test(reason)) throw new Error('Motivo inválido.');
  return reason;
}
export function validateModerationInventory(response) {
  const rows=response?.data;
  if (!Array.isArray(rows) || rows.length>MODERATION_VIEW_LIMIT ||
      new Set(rows.map(row=>row?.id)).size!==rows.length ||
      !rows.every(row=>row && typeof row.id==='string' &&
        typeof row.name==='string' && row.name.length>=2 && row.name.length<=48 &&
        typeof row.publisher_active==='boolean' &&
        Object.keys(row).sort().join(',')===
          'created_at,id,name,publisher_active')) {
    throw new Error('Inventario administrativo inválido.');
  }
  return rows;
}
const validEvent = row=>row && typeof row==='object' &&
  ['id','view_id','view_name','actor_user_id','view_owner_id','reason','action','created_at']
    .every(key=>typeof row[key]==='string') &&
  row.action==='revoke_share' && row.reason.length>=8 && row.reason.length<=200 &&
  Object.keys(row).sort().join(',')===
    'action,actor_user_id,created_at,id,reason,view_id,view_name,view_owner_id';
export function validateModerationAudit(response) {
  const rows=response?.data;
  if (response?.page_size!==MODERATION_AUDIT_LIMIT ||
      !Array.isArray(rows) || rows.length>MODERATION_AUDIT_LIMIT ||
      !rows.every(validEvent)) {
    throw new Error('Historial de moderación inválido.');
  }
  return rows;
}
export function validateModerationRevoke(response) {
  if (!validEvent(response?.data)) throw new Error('Revocación inválida.');
  return response.data;
}
