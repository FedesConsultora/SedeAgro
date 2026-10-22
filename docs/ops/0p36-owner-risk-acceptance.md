# 0P.36 — Identidad humana / firma de aceptación de riesgo de imágenes (NO-GO)

## Alcance y situación real

El receptor GitHub valida los cinco archivos Syft/Trivy + recibo y
las dos piezas del Docker-save OCI mediante GitHub Sigstore/SLSA
vinculado al SHA del workflow de `main`. Una firma de CI **no es**
una firma humana de aceptación de riesgo. El recibo real de CI tiene
`release_go=false`, incluso cuando no hay HIGH ni CRITICAL.

Este bloque aporta un verificador independiente de aceptación humana
de riesgo, separado del mecanismo operativo y **sin activar despliegues**.
`scripts/production-preflight.sh`,
`scripts/verify-production-image-admission.mjs` y
`scripts/deploy-prod.sh` quedan sin cambios y niegan la promoción.

## Política de confianza (no hay usuarios autorizados por defecto)

`scripts/security-owner-trust.json` se crea con
`trusted_keys: []`. No hay clave inventada, autocertificación,
passphrase, clave privada, certificado, URL de keyserver ni excepción
de pruebas en producción. Así la ejecución real del CLI siempre
termina DENIED hasta que un responsable nombrado complete
**otra revisión independiente**, preferentemente con CODEOWNERS y
protección de rama, para registrar su clave pública Ed25519 SPKI DER
(base64) y su SHA-256 fingerprint como `key_id`.

Una entrada debe tener:
- `role: "security_owner"`
- `owner_id` único y público, claramente identificable por proceso
- `spki_der_base64` (clave **pública**, nunca privada), `key_id` SHA256
  del DER, `revoked: false`, `valid_from` y `valid_until`
- autorización humana y proceso de revocación verificables. El repo
  es la raíz de confianza; aprobar un PR que cambia esa raíz requiere
  verificación independiente de quién revisó. Si se compromete la
  raíz de confianza del código, este verificador no sustituye la
  seguridad de GitHub/branch protection.

El CLI **no acepta** `--pubkey`, `--trust-store` o una clave
provista por quien solicita el despliegue. Pruebas usan claves Ed25519
efímeras que nunca se escriben al repositorio.

## Qué firma el Security Owner

Formato JSON con claves de nivel superior `statement` y `signer`.
El `statement` contiene, sin campos adicionales:

- schema `sedeagro-security-owner-risk-acceptance-v1`
- repository `FedesConsultora/SedeAgro`, source_ref
  `refs/heads/main`, release_sha 40-hex
- SHA256 completo del TAR OCI + SHA256 de los bytes del recibo OCI
- SHA256 del recibo de seguridad Syft/Trivy firmado por GitHub
- `image_ids.backend` y `image_ids.frontend`: hashes de config
  `sha256:...` que el TAR verificado y `docker image inspect` dan
- riesgos idénticos a los cinco contadores (CRITICAL, HIGH, MEDIUM,
  LOW, UNKNOWN) + findings de Trivy, coherentes y HIGH/CRITICAL 0
- `decision: "ACCEPT_RESIDUAL_IMAGE_RISK_FOR_CANDIDATE_ONLY"`
- `scope: "SECURITY_RISK_ONLY_NO_DEPLOY_AUTHORIZATION"`
- explicación específica del riesgo remanente (`risk_rationale`),
  `issued_at`, `expires_at`, `nonce` aleatorio 128-bit

La firma detached Ed25519 es de los bytes UTF-8
`SEDEAGRO_SECURITY_OWNER_RISK_ACCEPTANCE_V1\n` seguidos por el
JSON canónico con keys ordenadas recursivamente y por un LF final.
`signer.key_id` debe coincidir con el hash de la clave pública
registrada; `signer.signature_base64` debe ser la firma Ed25519
canónica de 64 bytes codificada en Base64 estricto. Este módulo
**verifica**, no implementa un comando de firma o reemisión de tokens.

La aprobación vence como máximo 24 horas después de emitirse.
No admite aprobaciones viejas/futuras, claves revocadas, fuera de
período o distintas de Security Owner. Se bloquea la reutilización
contra cualquier otro SHA/imagen/riesgo o recibo. Reutilización del
mismo documento dentro de su misma ventana y candidato no constituye
aprobación repetida por otra persona; un futuro operador debe tener
registro de revocación/nonce de un solo uso y bloqueo de promoción.

## Procedimiento hipotético (todavía NO activado)

Después de revisión independiente de la clave y evaluación del
MEDIUM/UNKNOWN, mantener en un directorio externo, privado 0700:

- `oci/sedeagro-images-<SHA>.tar` y JSON receipt
- `security/` con las 5 piezas y firmas verificadas por `gh attestation`
- `approval/sedeagro-owner-approval-<SHA>.json` (0600)

El CLI `node scripts/verify-release-owner-approval.mjs --sha
<SHA> --evidence-dir <DIRECTORIO_PRIVADO>` requiere la raíz de
confianza del checkout, comprueba firmas GH OIDC/Sigstore sobre
todos los archivos, relación SHA/TAR/imagen/riesgo y después firma
humana. Con el registro actual vacío devuelve exit 2, sin hacer
ninguna mutación o abrir Docker. Sus mensajes de error no muestran
secretos ni archivos privados. No existe variable para saltar
validaciones.

**El éxito eventual de este validador se expresa como**
`SECURITY_OWNER_IMAGE_RISK_SIGNED_NOT_DEPLOYED` con
`production_go:false`, `staging_certified:false`,
`time_of_use_certified:false` y
`other_owners_approved:false`. Nunca altera
`review.release_go` del recibo CI. Esa decisión humana es un
insumo, NO la autorización final de Release, Data u Operations.

## Pruebas y límites

La batería reproduce firmas efímeras reales (Ed25519) y rechaza
self-sign, cambiador de clave, revocado, identidad/rol incorrecto,
expiración, más de 24 h, sha/OCI/security receipt/config falsos,
riesgo ocultado, HIGH/CRITICAL, campos extra, firma mutilada,
mal codificada, reutilización con otros SHAs y ausencia de firma.
CI siempre verifica que el trust store REAL continúe vacío.

**Faltantes externos antes de GO:** inscripción real de la clave
Security Owner bajo proceso independiente, firma verificable de
riesgos, verificación de estado de revocación en la ventana de
promoción, punto de uso Docker (exclusividad y TOCTOU), staging
privado HTTPS autorizado, restauración off-VPS/rollback real,
aceptación móvil Android/iOS offline, performance #143 y firmas
finales Security, Operations, Data y Product.

P0-S05b2b mantiene esta deuda explícita. El código actual de
`deploy-prod.sh` continúa reconstruyendo imágenes y está bloqueado.
No se accedió a VPS, DB privada, secretos, DNS, staging o producción.
