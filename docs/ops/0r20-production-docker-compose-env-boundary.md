# 0R.20 — Límite de ambiente Docker/Compose para un release SedeAgro

**Fecha:** 10/11/2026 · Coordinación #18 · Release #130 sigue **NO-GO**.

## Falla de aislamiento corregida

`scripts/production-preflight.sh` ya obligaba a un SHA remoto exacto, credenciales no reutilizadas, configuración exclusiva de producción, checks de dependencias, firmas OCI y revisión de riesgo humano. Sin embargo, Docker y Compose **interpretan variables de entorno heredadas** antes del YAML. Un operador con `DOCKER_HOST` / `DOCKER_CONTEXT` apuntando a otro daemon, o `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME` y `COMPOSE_PROFILES` configuradas, podría ejecutar el mismo comando contra otro destino o activando servicios ajenos al plan. También era posible heredar IDs de imágenes OCI de una sesión previa.

El preflight ahora rechaza valores **no vacíos** de variables de:
- Conexión, credenciales o arquitectura Docker: `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `DOCKER_CONFIG`, `DOCKER_DEFAULT_PLATFORM`, `BUILDX_BUILDER`.
- Selección de Compose: `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, `COMPOSE_ENV_FILES`, `COMPOSE_PROFILES`, `COMPOSE_DISABLE_ENV_FILE`, `COMPOSE_PATH_SEPARATOR`, `COMPOSE_IGNORE_ORPHANS`.
- Imagen propuesta desde el entorno del operador: `SEDEAGRO_OCI_BACKEND_IMAGE` y `SEDEAGRO_OCI_FRONTEND_IMAGE`.

Esta verificación ocurre **antes** de revisar Git, secretos, escáneres de seguridad, firmas de artefactos y operaciones Docker. No muestra el valor encontrado en el mensaje (podría contener URL, password o un endpoint privado); sólo el nombre de la variable prohibida. El script de despliegue continúa llamando al preflight, sin flags para omitirlo.

## Evidencia de regresión

`node --test scripts/test/production-preflight.test.mjs` comprueba en un repositorio Git sintético todos los overrides por separado, con valores de prueba sensibles y sin imprimirlos. Sin overrides, el flujo debe seguir hasta el **bloqueo previo existente de evidencias OCI firmadas**: el nuevo control no autoriza el despliegue.

## Riesgo restante y aceptación

La política únicamente establece el ambiente de entrada; no demuestra que Docker usará imágenes firmadas durante el cutover. La firma de riesgo humana sigue ausente del registro actual; `deploy-prod.sh` continúa reconstruyendo imágenes y el gate de admisión lo rechaza. Para habilitar producción se requieren aceptación independiente de Seguridad/Operaciones, promoción exacta por IDs `sha256:` sobre un host autorizado, restore/rollback real de backup externo, staging aislado y los 22 casos MOB en dispositivos físicos.

**No desplegar SedeAgro ni alterar hosts reales a partir de estas pruebas.**
