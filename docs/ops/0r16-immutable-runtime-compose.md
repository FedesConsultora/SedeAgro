# SedeAgro 0.1 — 0R.16: Compose productivo resuelto por identidad inmutable de imagen

**Fecha:** 10/11/2026 · Repo main exacto al reclamar: `814119be1e0418126a2a55f2cb46e1a78931f87e` · Coordinación #18 · Release #130: **NO-GO**.

## Problema concreto

La prueba anterior `ci-oci-production-overlay.mjs` compara la topología real de `docker-compose.yml` más `docker-compose.oci-production-override.yml`, conservando redes/volúmenes/servicios y prohibiendo rebuild/pull, pero resuelve `image: sedeagro-backend-rc:<SHA>` / `sedeagro-frontend-rc:<SHA>`. Aun con SHA literal, **un tag local de Docker sigue siendo mutable**. El bloque 0P.37 ya demostró en Docker desechable la creación de contenedores *detenidos* usando el ID de configuración `sha256:...`, no el tag; faltaba probar que el **Compose productivo** también puede resolverse exactamente con esos IDs y que ninguna otra propiedad cambia.

## Nuevo gate read-only en CI

`scripts/ci-oci-immutable-runtime-compose.mjs` se ejecuta **después** de la verificación real de Sigstore/GitHub OIDC, Trivy/SBOM, la importación completa del TAR OCI y la creación/limpieza de contenedores detenidos. Opera solamente en un runner nuevo de GitHub Actions sobre `push` a `main` y SHA40 exacto.

Primero reejecuta el preview de producción y la verificación TAR/recibo/IDs sobre el mismo daemon. Después utiliza archivos Compose versionados y una copia temporal con `.env` *sintético*, nunca archivos `.env` del host. Resuelve, mediante `docker compose config --no-env-resolution --format json`, exactamente tres variantes:

1. Base actual: conserva DB PostGIS, Redis, cuatro servicios, red privada/external `fedes-net`, puertos y volúmenes.
2. Overlay con **tags CI**: se compara con el baseline usando `validateProductionOverlay`, que sólo admite quitar `build` y añadir `image` + `pull_policy: never`.
3. Overlay con **IDs de configuración inmutables** del recibo `sha256:...`, distinto únicamente en el valor `image` de backend y frontend. Una comparación profunda de la configuración resuelta exige identidad de todas las demás propiedades.

El programa inspecciona **dos veces** cada imagen Docker mediante su ID inmutable, comprueba `Id`, OS/arquitectura, digest RootFS por capa, etiqueta de revisión SHA y metadato del backend; rechaza un tag reasignado, un overlay que reconstruya, habilite pull, exponga puertos o cambie DB/Redis. Las respuestas no contienen secretos.

## Contrato de salida

El éxito publica `CI_OCI_IMMUTABLE_ID_PRODUCTION_COMPOSE_RESOLVED_NOT_DEPLOYED` con SHA, hash del archivo y los dos IDs `sha256:`, además de `containers_started:false`, `production_go:false`, `security_owner_approved:false`, `time_of_use_certified:false`. Es **evidencia de configuración y bytes verificables sobre un Docker daemon desechable**, no que una instancia real ya los use.

La CI ejecuta `node --test scripts/test/ci-oci-immutable-runtime-compose.test.mjs` (mutantes de topología, digest, imagen, RLS/privacidad por ausencia de modificaciones, falta de CI) y también el gate real dentro de `offline-image-import`.

## Límites de seguridad y pendiente de producción

No se cambia `deploy-prod.sh` ni `production-preflight.sh`, no se modifica `verify-production-image-admission.mjs`, no se enrolan claves públicas y **no se inicia/crea/recrea ningún contenedor** desde el nuevo script. La admisión continúa denegando el rebuild local; ningún paso usa `docker compose up`, `run`, `pull`, `build` o `start`. Ningún servidor, staging ni VPS fue tocado.

Para una promoción real faltan: Security Owner con firma auténtica de riesgo sobre SHA, Ops con procedimiento de importación y actualización atómica/rollback según evidencia, validación de backup/restore separado, QA de campo Android/iOS con red rural, pruebas HTTP con seis actores y aceptación humana final de #130.

**No ejecutar este preview como comando de despliegue.**
