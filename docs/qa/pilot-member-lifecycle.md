# SedeAgro 0.1 — Tenant member suspension and reactivation (P0)

## Real production value

An administrator must be able to remove field access for a departed scout or
contractor **without deleting historical authorship, tasks, audit evidence or
multiempresa identity**. Restoring an eligible account must not resurrect an
old revoked cookie/JWT or exceed plan seats.

Endpoint: `PATCH /api/v1/auth/members/:membershipId/status`
with `{"status":"blocked"}` or `{"status":"active"}`.
Legacy `/api` prefix shares the same handler.

- Requires logged-in `tenant_admin` through `members.manage` and
  server-side tenant RLS. No arbitrary user ID, role or tenant may be supplied
  as the target. The target is a tenant-scoped membership UUID.
- Cannot target self, another administrator, platform role, another tenant,
  or pending/unknown membership. A blocked user remains in historical records.
- The tenant row is locked before the member row. Re-activation checks active
  users **plus unexpired pending invitations** against plan.max_users. A globally
  blocked User cannot be reactivated by a tenant admin.
- Suspension revokes ALL persisted sessions belonging to that member within
  that tenant. Existing bearer/cookie cannot authenticate again; reactivation
  requires a new login and does not undo revoked session timestamps. A user's
  memberships in other tenants are not touched.
- Same-status retry returns HTTP 200 with `changed:false`; a real transition
  returns `changed:true`. Only actual transitions produce an audit event,
  never passwords, bearer tokens or invitation secrets.
- UI displays **membership.status** independently of User.status. Only
  authorized admin sees confirmation buttons; acknowledged response must
  match selected member UUID, tenant, user, role and intended state. No
  optimistic success after ambiguous HTTP or account switch.
- Demo remains simulated; no POST/PATCH made under mock mode.

## Acceptance

Unit: `backend/test/memberLifecyclePolicy.test.js` and
`frontend/test/memberLifecycleSafety.test.js`.

Disposable migrated PostGIS: `backend/test/memberLifecycle.pg.mjs`, run
under a non-owner role with FORCE RLS through normal test:db CI. Real HTTP:
self, foreign, role-denied, invalid state, idempotent suspend/activate,
existing active login invalidated, revoked session still denied on restore,
fresh login succeeds, disabled global User denied, small-plan quota denied,
two audit entries only, runtime direct RLS cross-tenant read empty.

Release #130 remains NO-GO until authorized staging and Android Chrome/iOS
Safari real actors pass the complete journey including account revocation
mid-session, offline pending notes never sent as revoked actor, and independent
postmerge main checks. No deploy, migration or GitHub Actions edits here.

Limits: this endpoint does not permanently delete User data or change the
stored role. Existing task assignment historical rows remain for audit. It
does not retroactively guarantee removal of already-decrypted bytes on an
offline device; privacy policy must address trusted-device access.
