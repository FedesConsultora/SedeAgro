# PILOT-TEAM-INVITE — Backend acceptance (P0 / issue #222)

Base: main@2d60a392a8e91db6ebac1e34baaf7c723cf825bb.
Owner claim: #18, separate from TeamPage and orders UI claims.

## Supported, with an explicit delivery limitation

- `POST /api/v1/auth/invitations` (scoped tenant_admin): `{email,roleCode}`.
  Allowed invite roles: scout, contractor, agronomic_coordinator, producer_viewer.
  Return 201 with a **single-use secret shown once** in `delivery.token` and
  `delivered:false`. The backend **does not send an email**. Admin must use a
  secure out-of-band channel; never paste the token in issue/analytics/logs.
- `GET /api/v1/auth/invitations` (scoped tenant_admin): up to 100 most recent
  entries, email, role, state and expiry, **never secret nor token hash**.
- `DELETE /api/v1/auth/invitations/:invitationId` (scoped tenant_admin):
  atomically revoke pending invitation; 204 only after DB commit.
- `POST /api/v1/auth/invite/accept` (public, body only):
  `{token,password,fullName?}`, 201 on activation and `next:login`.
  New accounts choose a password and full name; existing accounts must prove
  their current password (never reset password through an invitation).
  Full authentication occurs via normal `POST /auth/login` afterwards.
- Both `/api` and `/api/v1` prefixes already share the routers.
- The token embeds a non-secret tenant UUID plus 256-bit random bearer secret.
  Only SHA-256 of the complete token is stored in Postgres. Seven-day TTL;
  accepted/revoked/expired tokens cannot grant a second membership.
- `member_invitations` uses FORCE RLS and tenant-scoped inviter FK; each
  modification runs in a tenant-scoped transaction.
- Tenant row lock serializes seat-budget checks, revocations and acceptance
  against simultaneous issuance. Active memberships + unexpired pending
  invitations count toward the tenant's `plans.max_users`.
- Tenant administration cannot mint platform_admin or tenant_admin roles.
  No automatic roles/memberships inferred from matching cross-tenant emails.
- Audits record the invitation ID/action and role/status, but no token.

## Critical validation

`npm --workspace backend test -- --test-name-pattern=invitation` is not a
replacement for the full suite. The CI tenant-rls job must execute
`npm --workspace backend run test:db` against disposable migrated PostGIS,
runtime non-owner, and enforce FORCE RLS and HTTP test in
`backend/test/memberInvitations.pg.mjs`.

Acceptance: admin invite/revoke; other actor denied; tenant B cannot list,
revoke or accept A data without the secret; verify token isn't persisted;
single-use accept; wrong/weak passwords rejected; existing-user password
preserved; new user can subsequently sign in; seat quota and concurrent
acceptances; no secret on list/audit/errors; 7-day expiry.

## Remaining before pilot release

1. Implement `TeamPage` live invitation creation and one-time secure
   manual delivery (or a real verified email channel) with honest states;
   no mock invites or false sent confirmations.
2. Verify realistic seat-plan edge cases and 2 concurrent acceptance requests
   in PostGIS; verify expired tokens with DB clock and API behavior.
3. Physical Chromium Android / Safari iOS and authorized staging E2E.
4. Release issue #130 remains NO-GO; **no production deployment authorized**.
