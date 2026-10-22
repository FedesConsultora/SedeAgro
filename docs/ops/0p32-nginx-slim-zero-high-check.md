# 0P.32 — official Nginx Alpine Slim: reduce runtime attack surface without mutable apk upgrade

## Why: signed evidence from 0P.31

`main@d095e6a7dc8d2135771e9071cef5d7e84721ad34` runs Nginx
1.30.6 Alpine 3.24.2. Actual postmerge Syft/Trivy security artifact
`#12400652561` includes 13 findings (0 CRITICAL / 2 HIGH / 7 MEDIUM /
4 UNKNOWN). High package findings are:

- `CVE-2026-77214`, `libexpat 2.8.5-r0`, fixed `2.9.0-r0`
- `CVE-2026-88806`, `libx11 1.8.13-r0`, fixed `1.8.14-r0`

The static SPA/API reverse proxy uses no extra X11, graphics or NGINX modules.
Rather than performing non-reproducible repository `apk upgrade` during each
build, choose the **official slim variant**, which is built from a newer
Alpine base and omits optional image-processing/graphics libraries.

## Reviewed immutable upstream bytes

- Tag `nginx:1.30.6-alpine3.24-slim`
- Multi-platform OCI index `sha256:a6cc4968d63e87b7d78fb0e089dcd85a6c88e7660b9b06ee0c9b380ac7bc5593`
- linux/amd64 manifest `sha256:8f06fd647c6687eae0fd7bee8a43df66e61edb9f093bb0a9079d69cb355b879b`
- Public official image metadata: https://github.com/docker-library/repo-info/blob/master/repos/nginx/remote/1.30.6-alpine3.24-slim.md
- Reported build date 2026-10-21 and underlying Alpine minirootfs 3.24.3.
- CI enforces `docker buildx imagetools inspect <tag@exact-index>`
  including media type/digest/amd64. Refuses any tag-only fallback.
- The GitHub built image, its Syft and Trivy results, signed receipts and
  verified offline archive are separate from the public upstream digest.

## Acceptance / scope

- Only `frontend/Dockerfile`, 1 image lock entry, policy allowlist,
  matching guards, exact pair of real Nginx browser smoke image refs and
  this runbook change. No code/UI/API/DB/roles/migrations/Compose edits.
- Browser loopback `nginx -t`, security headers/cache/static file manifest,
  full frontend Chromium offline tests, and prod image-byte parity must PASS.
- Real Trivy full OS+language scan must verify absence of original
  `libexpat` and `libx11` HIGH findings on the built image. **Do not
  declare zero HIGH unless those actual exact SHA scans prove it**.
- Four premerge active jobs PASS exact head; six independent push/main
  jobs PASS after a permitted normal merge; artifact SHA and attestations
  must bind to that new merge SHA. No CVE suppression or loosened gates.
- Remaining MEDIUM/UNKNOWN and any newly discovered HIGH are not implicitly
  waived. The operator security review and external authorization/QA
  are independent gates. **SedeAgro beta 0.1 remains NO-GO** until private
  staging HTTPS, RLS/roles/auth acceptance, off-VPS backup/restore/rollback,
  device offline acceptance and signoff.
- No deployment/VPS/staging/prod/secret/production DB touched.
