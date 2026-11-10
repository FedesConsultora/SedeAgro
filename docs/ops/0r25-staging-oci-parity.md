# 0R.25 — Staging aislado usando los mismos IDs OCI firmados

**10/11/2026 · Coordinación #18 · Release #130: NO-GO.**

## Objetivo

El staging declarado en `docker-compose.staging.yml` dispone de nombres, puertos loopback, red privada, volúmenes y passwords separados de producción, pero los servicios backend/frontend todavía declaran `build`. Si se construyen allí, sus bytes no son los mismos del TAR CI firmado, aunque coincidan los SHAs de fuente.

Se agrega un overlay *de vista previa*, `docker-compose.staging-oci-override.yml`, que aplica `build: !reset null`, sustituye únicamente las referencias `image` por `sha256:<config-id>` para backend y frontend y exige `pull_policy: never`. No se modifica el YAML original ni se cambia la topología de staging. **No usar todavía este overlay con `docker compose up` en un host real.**

## Prueba real y fail-closed

`scripts/ci-oci-staging-immutable-preview.mjs` sólo se ejecuta como parte del segundo runner desechable GitHub Actions, en un `push` de `main` SHA40 exacto. Requiere previamente la firma OIDC de los dos artefactos OCI, los cinco de seguridad Syft/Trivy, importación desde el TAR, capa/ID inmutable y `ci-oci-immutable-runtime-compose.mjs` para producción. Nunca admite un ID no presente en el recibo del archivo firmado.

El script utiliza un directorio privado temporal con copias de los dos YAML versionados. Dos comandos **`docker compose config --no-env-resolution --format json`**, con `--env-file /dev/null` y secretos de prueba sintéticos constantes, producen:

1. La configuración de staging sin overlay, que debe pasar integralmente `validateStagingTopology` del repo: cuatro servicios `db/redis/backend/frontend`, extensiones PostGIS, redis digest fijado, contenedores sin privilegios, red `internal: true`, dos volúmenes propios, credenciales separadas, política de entorno, CORS HTTPS, readiness y publicación **únicamente `127.0.0.1:4183`** del frontend.
2. La misma configuración con overlay OCI, que se compara en profundidad con el objeto anterior después de quitar exclusivamente los dos atributos `build`, sustituir los dos valores `image` por los IDs `sha256:` firmados e incluir dos valores `pull_policy: never`.

Cualquier variación de contraseña, URL, healthcheck, red, montajes, base, redis, puertos, nombre de proyecto o servicio adicional bloquea. Las configuraciones resueltas contienen secretos sintéticos y **nunca se imprimen ni guardan como artefactos**.

La prueba devuelve `CI_SIGNED_OCI_IMMUTABLE_STAGING_COMPOSE_PARITY_NOT_DEPLOYED` con IDs, SHA y flags `staging_certified:false` y `production_go:false`. Los tests incluyen mutaciones adversariales y **el parser Compose real** del runner de CI, no sólo un mock.

## Lo que esto NO hace

No levanta contenedores ni usa `.env` del servidor, no migra ninguna BD, no cambia el proxy TLS, no modifica VPS ni crea claves o autorizaciones. También queda fuera el procedimiento de rollback y la importación física al host (bloque 0R.22). Este paso es preparación de configuración y es deliberadamente **distinto de un despliegue de staging real**.

Para GO todavía se requieren autorización de staging, importación de TAR firmado con aceptación humana real, ejecutar y verificar la instalación en entorno aislado, backup off-VPS restaurado, rollback, mediciones HTTP 1/25/100/250 y review queue, 22 casos móviles físicos, seis actores, y firmas de Producto/Seguridad/Ops/Datos.

Hasta realizarse, el release #130 permanece **NO-GO**.
