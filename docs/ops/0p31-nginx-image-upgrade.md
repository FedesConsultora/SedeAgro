# 0P.31 — patched official Nginx/Alpine runtime (release NO-GO until accepted)

## Why this exists

The prior signed main candidate at `0f1709a800a9b764e5c7b14bc2ab643029b0c69a`
reported 2 CRITICAL and 57 HIGH in the final frontend container, with Nginx
`1.27-alpine` / Alpine 3.21.3. Not an npm frontend advisory problem.
Backend global npm had already been removed in PR #165. Do not roll back that fix.

## Reviewed upstream bytes, with no floating release dependency

- Official tag: `nginx:1.30.6-alpine3.24` (NGINX stable 1.30.6, Alpine 3.24).
- Immutable **OCI image index**, not architecture-specific manifest:
  `sha256:ff8328b4279ec385af48cde9ef486e7165ad74b7065cb3cd86c377384e2e2dd5`.
- Upstream public provenance: https://github.com/docker-library/repo-info/blob/master/repos/nginx/remote/1.30.6-alpine3.24.md .
- Indexed linux/amd64 manifest:
  `sha256:959ae6b898852db82e5b29b929388e59914f42be0a8f4d44c89a4c1f53b49208`
  (listed by upstream repo-info; the repository locks the OCI multi-platform index).
- Public image metadata lists `NGINX_VERSION=1.30.6`, Alpine 3.24.2,
  supported linux/amd64, and the standard nginx entrypoint/config locations.
- The index is not an independent supply-chain **signature**. Docker `imagetools
  inspect tag@sha256` in CI checks registry reachability, media type, digest
  and linux/amd64 before any image build. If the exact index stops resolving,
  CI MUST fail, not substitute a current floating tag.

## Changed exclusively

1. `frontend/Dockerfile` pins the new official runtime and leaves Vite build,
   reviewed nginx.conf, revision label, document-root purge and assets untouched.
2. `scripts/base-image-lock.json` and `scripts/verify-base-image-pins.mjs`
   agree on the exact digest/tag.
3. Base-image and container guard regression tests reject stale runtime tags
   and require two browser gate references to the identical approved index.
4. `browser-offline` now runs both `nginx -t` and real loopback HTTP headers,
   cache and manifest acceptance using **the same exact digest**, not the old
   unpinned `nginx:1.27-alpine`.

No compose service names, production database or API, authentication,
frontend UI, offline queue, or migrations were modified.

## Release acceptance: fail closed, no CVE baseline suppression

- PR HEAD must show **4/4**: tenant-rls, browser-offline,
  production-images, dependency-security. The two main-only artifact/sign jobs
  are not PR gates.
- Docker build `--target prod` must succeed on linux/amd64; Nginx startup,
  `nginx -t`, static headers, /api proxy config syntax, real browser and
  byte-parity manifests must all pass.
- Syft SPDX and Trivy **both** images full OS+library scan must bind to
  exact local image ID and PR SHA. Check the actual final report and severity
  counts; only its output determines whether HIGH/CRITICAL are gone. Scan
  output MUST NOT be overridden by npm audit success or this document.
- After permitted normal merge, require **6/6** independent push/main checks
  with an exact new SHA, OCI archive + security artifact + Sigstore attestation
  + verified offline Docker re-import. Old SHA artifacts cannot certify a new SHA.
- Release remains **NO-GO** if any CRITICAL/HIGH from final image, missing scan,
  base digest drift, failed CI, or missing private staging/HTTPS, off-VPS
  backup+restore, rollback and Android/iOS field testing. This PR changes
  source and disposable CI only; never touches a real VPS/DB/DNS or secrets.
