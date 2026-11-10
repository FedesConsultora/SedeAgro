# 0R.14 — Admisión de imágenes: separar escaneo firmado y firma humana de riesgo

**Fecha:** 10/11/2026 · Coordinación #18 · Release #130 NO-GO.

## Bloqueo de producto/operaciones encontrado en código

`scripts/verify-production-image-admission.mjs` rechazaba el informe OIDC/Sigstore de CI porque exigía `security.review.release_go === true`, `security_owner_review_required === false` y `release_gate === APPROVED_FOR_RELEASE`. Sin embargo, el informe firmado que emite la CI es **deliberadamente de solo revisión** con `release_go:false`, `security_owner_review_required:true` y `release_gate:EXTERNAL_SECURITY_REVIEW_REQUIRED`. No corresponde editar ni falsificar ese recibo: los reportes Trivy/Syft y su firma de origen prueban integridad del escaneo, **no aceptación de riesgo por una persona autorizada**.

Existe además `scripts/verify-release-owner-approval.mjs`, que comprueba firma Ed25519 humana de contexto de riesgo: SHA40, digest del TAR OCI, recibo OIDC, IDs de configuración backend/frontend, digest de escaneo, conteos de vulnerabilidades y ventana temporal. El archivo versionado `scripts/security-owner-trust.json` mantiene `trusted_keys: []` hasta registrar una clave pública real mediante revisión independiente.

## Integración de garantías sin autorizar producción

1. La admisión valida el recibo OIDC **sin reescribir `release_go:false`** y exige severidades `CRITICAL, HIGH, MEDIUM, LOW, UNKNOWN` completas, no negativas y con suma consistente; cualquier HIGH/CRITICAL continúa bloqueando.
2. Verifica **por separado** OCI firmado desde `refs/heads/main`, identidad de repositorio/flujo y archivo TAR/recibo del SHA exacto.
3. Requiere un directorio de evidencias `approval/` **privado y canónico**, fuera del checkout; lee `sedeagro-owner-approval-<SHA>.json` como archivo regular de 1 enlace, ≤16 KiB y permisos privados. No permite claves/roster por `env` o CLI.
4. Reutiliza las funciones criptográficas existentes `verifiedReleaseRiskContext` y `verifySecurityOwnerApproval` para validar el riesgo frente al reporte y las imágenes exactas. El resultado debe indicar **solo aceptación de riesgo** (`SECURITY_RISK_ONLY_NO_DEPLOY_AUTHORIZATION`), y mantener `production_go:false`, `staging_certified:false`, `time_of_use_certified:false`, `other_owners_approved:false`.
5. **El bloqueo final sigue incondicional**: `deploy-prod.sh` reconstruye imágenes Docker locales; esto no demuestra identidad byte a byte de los artefactos OCI firmados en CI. La admisión termina en `deny('deploy-prod.sh rebuilds Docker images...')` incluso con aprobación hipotética válida.

## Pruebas y límite

`node --test scripts/test/production-image-admission.test.mjs` verifica los contratos nuevos, recibos falsificados, firmas ausentes, roster vacío, directorios inseguros, flags de GO inventados y prohibición de saltar el hard-stop. La suite criptográfica independiente `scripts/test/release-owner-approval.test.mjs` mantiene la verificación real Ed25519; la CI completa exige cinco checks en PR y siete en main. Ningún test declara aprobación real del Security Owner.

El contrato no ejecuta Docker, **no habilita ningún despliegue**, no altera claves ni secreta un bypass. Para producción todavía falta enrolamiento humano de clave pública, firma de riesgo auténtica, promoción de imágenes exactas sin rebuild ni pull, aceptación de datos/backup/restore/staging/mobile por sus responsables y autorización de cutover. Por eso **#130 sigue NO-GO**.

## Reversión

Revertir código de admisión no toca sistemas reales. No editar el recibo OIDC para simular autorización ni modificar el roster `trusted_keys` desde agentes. Toda modificación futura del bloqueo de rebuild necesita PR aparte, QA de artefactos y aprobación explícita Security/Operations.
