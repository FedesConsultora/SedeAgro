# 0R.18 — Plan productivo OCI con IDs inmutables comprobado en el host

**Fecha:** 10/11/2026 · Issue #18 · Release #130 **NO-GO**.

## Problema y cambio

El gate independiente de CI `ci-oci-immutable-runtime-compose.mjs` ya demostró que `docker-compose.yml` más `docker-compose.oci-production-override.yml` pueden resolverse con los dos IDs de configuración `sha256:...` firmados, sin volver a construir imágenes. Pero el inspector read-only disponible para el operador en el servidor, `scripts/inspect-host-oci-compose.mjs`, solo comprobaba el overlay con tags mutables `sedeagro-*-rc:<SHA>`. Esto dejaba sin una prueba de **paridad por ID inmutable sobre el host**.

El script ahora ejecuta tres `docker --context default compose config --no-env-resolution --format json` sobre copias temporales del YAML del repositorio (con `.env` sintético sin datos reales):

1. **Base**: topología de cuatro servicios, DB/Redis fijados por digest, redes/volúmenes/puertos originales.
2. **Overlay con tags**: `build` eliminado para backend/frontend y `pull_policy: never`.
3. **Overlay con IDs**: los únicos cambios respecto del punto 2 son `image: sha256:<config-id>` exacto para backend y frontend, desde el recibo OCI firmado.

Se reutiliza `validateImmutableRuntimeCompose` de CI, con comparación profunda de todo el plan: quedan inmóviles DB, Redis, redes, volúmenes, dependencia, puertos, seguridad y demás opciones de servicios. Los IDs deben coincidir con el recibo OCI cuyo TAR, resumen Syft/Trivy y siete sujetos firmados ya validó `inspectHostSignedImages`.

**Después** de resolver Compose por IDs, se vuelve a ejecutar `inspectHostSignedImages` para comprobar que siguen siendo válidos la raíz Sigstore/GitHub, firma de la fuente, identidad y capas de las imágenes en el Docker **local** `unix:///var/run/docker.sock`. El doble examen detecta cambios de etiquetas/imagen mientras se construía el plan. No pretende solucionar por sí solo el riesgo TOCTOU entre revisión y creación futura de contenedores.

## Ejecución operativa (solo lectura)

En un host Linux controlado con Docker local y con los artefactos verificados **ya presentes** (este script no los importa), checkout Git `main` limpio y `origin/main` exactamente en el SHA:

```bash
node scripts/inspect-host-oci-compose.mjs \
  --sha <SHA_COMPLETO_40_HEX> \
  --evidence-dir /ruta/privada/canonica/de/evidencias
```

No exponer ni copiar claves dentro del checkout. La revisión no utiliza `backend/.env` ni `.env` productivos, y rechaza `DOCKER_HOST`, `DOCKER_CONTEXT`, `COMPOSE_FILE`, `COMPOSE_ENV_FILES` y otros overrides. Únicamente invoca el inspector firmado y **Docker config/image inspect**; no carga imágenes, no crea contenedores, no migra ni levanta redes.

El resultado es `HOST_SIGNED_OCI_COMPOSE_PARITY_READONLY_NOT_DEPLOYED` y agrega `immutable_config_ids_bound:true`, `mutable_tag_reference_in_final_plan:false` y `docker_identity_rechecked_after_compose:true`. Mantiene explícitamente `release_go:false`, `security_owner_approved:false`, `containers_created:false`, `production_deploy_certified:false`.

## Pruebas y límites de autorización

`node --test scripts/test/inspect-host-oci-compose.test.mjs` y `node --test scripts/test/inspect-host-oci-images.test.mjs` se ejecutan en la CI. Ejercitan mutaciones de tag/digest, overlays con build/pull, red/DB/Redis/volúmenes, inyección de secretos, identidad local inconsistente, y revalidación posterior a la configuración. Son pruebas read-only, con datos falsos: **no firman riesgo humano** ni hacen cutover.

Este bloque **no altera** `scripts/deploy-prod.sh`, `scripts/production-preflight.sh`, `scripts/verify-production-image-admission.mjs` ni el registro humano `scripts/security-owner-trust.json`. Hoy `deploy-prod.sh` sigue construyendo y el gate productivo lo rechaza. Aún faltan un procedimiento aprobado de carga/promoción desde el TAR firmado sin rebuild, atestaciones humanas auténticas, backup restaurado y rollback externo real, staging autorizado y las pruebas físicas Android/iOS/6 actores. **#130 sigue NO-GO.**
