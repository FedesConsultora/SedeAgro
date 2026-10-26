# Pilot P0 — Invitations frontend / TeamPage

This is a dependent UI branch on backend PR #228; never merge before #228.

## Administrator

- Live, authenticated `tenant_admin` with `org` entitlement can
  `POST /auth/invitations` from Equipo. All other roles are read-only.
- Email and role must be checked locally and on the server. The server ACK must
  match email, allowed role, real UUID, tenant-embedded 256-bit token, pending
  state, bounded seven-day expiry and `delivery.delivered === false`.
- No duplicate POST from a same-tick double click; after lost ACK,
  **no automatic retry**. Refresh pending list first.
- One-time secret exists in React memory only, is shown under explicit manual
  sharing instructions and is never in URL, localStorage, sessionStorage,
  analytics, emails or issue comments. A successful create is NOT delivery.
- List accepted/pending/revoked invitations without their secret; explicit
  confirmation before revoking. No other tenant's list/secret displayed during
  render-time account, actor, role, entitlement or API switch.
- Demo stays separate and does not call live API.

## Recipient

- From login choose `Tengo una invitación` and paste code in a form.
  It is sent in a POST JSON body, not a query string or fragment.
- New user supplies their full name and a strong chosen password. Existing
  user supplies their original password, without resetting it.
- Only confirmed 201 `{next:'login', data:{id,tenant,roleCode}}` shows
  success, then recipient signs in normally.
- Never persist token or password. No false success for ambiguous network or
  server failure. Only one in-flight activation.
- Keep normal multi-tenant login and demo unaffected.

## Release criteria

Targeted `node --test frontend/test/memberInvitationSafety.test.js`,
frontend build, existing TeamPage privacy/accessibility regressions,
non-owner PostgreSQL HTTP tests in parent PR, and Chromium keyboard-flow
confirmation on latest exact SHA. QA on Android Chrome, iOS Safari, and
authorized staging is mandatory before pilot GO. No VPS/prod changes.
