import { z } from 'zod';

export const REVIEW_VIEW_MODERATION_AUDIT_PAGE_SIZE = 50;
export const REVIEW_VIEW_MODERATION_REASON_MIN = 8;
export const REVIEW_VIEW_MODERATION_REASON_MAX = 200;

const normalizeReason = value => typeof value === 'string'
  ? value.normalize('NFC').trim().replace(/\s+/gu,' ') : value;

export const revokeSharedViewSchema = z.object({
  reason:z.string().transform(normalizeReason).pipe(z.string()
    .min(REVIEW_VIEW_MODERATION_REASON_MIN)
    .max(REVIEW_VIEW_MODERATION_REASON_MAX)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u))
}).strict();

export function parseRevokeSharedView(input) {
  const parsed = revokeSharedViewSchema.safeParse(input);
  if (!parsed.success) throw new Error('Motivo de revocación inválido.');
  return parsed.data;
}
export function publicModeratedSharedView(row) {
  return {id:row.id,name:row.name,created_at:row.created_at,
    publisher_active:row.publisher_active === true};
}
export function publicModerationEvent(row) {
  return {id:row.id,view_id:row.view_id,view_name:row.view_name,
    actor_user_id:row.actor_user_id,view_owner_id:row.view_owner_id,
    reason:row.reason,action:row.action,created_at:row.created_at};
}
