# 0P.34 — Frontera de consumidor Compose para imágenes OCI firmadas (CI solamente)

## Defecto preciso y separación de responsabilidades

0P.33 cerró la promoción productiva: `scripts/production-preflight.sh`
requiere cinco SBOM/Trivy/receipt firmados, y bloquea tanto
`release_go=false` como el rebuild local de `scripts/deploy-prod.sh`.
Esas barreras NO se relajan aquí.

CI ya verificaba la firma GH/Sigstore del TAR y del recibo, los cinco
archivos de seguridad, los hashes/configs/rootfs de ambas imágenes y el
`docker load` en runner independiente (`ci-oci-import-rehearsal.mjs`).
Pero no existía una aceptación de la **selección por Compose** posterior
a la importación. El Compose de producción aún contiene `build:` en
backend/frontend, por lo que no sirve para demostrar que consumiría
los mismos bytes OCI.

## Nuevo consumidor aislado

- `docker-compose.oci-review.yml`: proyecto **sedeagro-oci-review**
  dedicado; exactamente dos servicios `backend` y `frontend`, ambos
  `image:` por tag SHA40, `pull_policy: never`, `network_mode: none`,
  `read_only: true`, comando fijo de diagnóstico (`node --version` /
  `nginx -v`); sin `build`, ports, environment, secrets, DB, Redis,
  volúmenes, privilegiados, redes, restart, u otras aplicaciones.
  Es una especificación de **revisión** y NO una topología de pilot/staging.
- `scripts/ci-oci-compose-parity.mjs`: después de que el job receptor
  independiente verificó firmas y realizó `docker load`, valida
  nuevamente el TAR/receipt original completo, comprueba fuente SHA y
  digests, resuelve `docker compose -f docker-compose.oci-review.yml
  config --format json` (sin arrancar servicio), comprueba estructura
  exacta y dos tags aprobados; inspecciona y repite inspección de imagen
  importada y compara `image.Id`, capas RootFS, plataforma linux/amd64,
  etiqueta OCI revision e `SEDEAGRO_BUILD_SHA` del backend con el receipt.
- Invocación exclusiva **push/main exact SHA en runner descartable**,
  rutas en RUNNER_TEMP fijo y `GITHUB_REPOSITORY` exacto.
- Solo comandos Docker `compose ... config` e `image inspect`. El
  componente jamás llama `up`, `run`, `start`, `pull`, `build`,
  `load`, `tag`, `rm`, registra secretos ni escribe fuera de CI.
  No genera automáticamente archivos de autorización productiva.

La admisión no se basa en nombres de tag únicamente: valida identidad
criptográfica de config SHA256 y rootfs layers en las imágenes observadas.
Los tests incluyen Compose v2 real si está disponible, aparte de pruebas
sintéticas deterministas: más servicios, sustitución de tag/digest,
`build`, `pull_policy`, puertos/redes/env/privileged/mount,
`read_only`, alteración de TAR/receipt, imagen de otro SHA y retag
entre primera y segunda inspección. El resultado debe ser fail-closed.

## Qué demuestra y qué NO demuestra

Resultado `CI_OCI_IMAGE_ONLY_COMPOSE_REVIEW_NOT_DEPLOYED` prueba que
**una especificación de consumidor aislada y read-only** puede resolver
ambos tags que ya fueron importados y observados con IDs del TAR.
No prueba que Compose productivo utilice esa especificación, ni elimina
TOCTOU entre la última inspección y futura creación de contenedores.
No autoriza `deploy-prod.sh`, ni activa una ruta productiva de importación.

**P0-S05 operacional sigue abierto:** antes de un pilot real, exigir
decisión/firma independiente de Security Owner enlazada al SHA/receipt
y riesgo residual, consumidor productivo no-rebuild con identidad
revalidada en punto de uso, retención de evidencia, rollback de datos,
ensayo staging privado HTTPS con secretos separados y autorización
Operations/Data/Product. Recibo `release_go=false` = **NO-GO**.

## Aceptación

PR: 4/4 gates activos exact-head, incluyendo test Docker Compose real.
Tras merge normal: push/main 6/6 sobre merge SHA y, en el job
`offline-image-import`, se ejecutan en orden
`verify-oci-signed-provenance` →
`verify-image-security --mode verify-signed` →
`ci-oci-import-rehearsal --mode fresh` →
`ci-oci-compose-parity`.
Ningún artefacto o resultado de un SHA anterior es reutilizable.

Ningún VPS/DB privada/DNS/staging/producción/secreto fue accedido.
