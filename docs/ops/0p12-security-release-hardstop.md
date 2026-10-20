# 0P.12 — Admisión productiva de seguridad fail-closed (NO equivale a resolver #137)

## Hallazgo de riesgo P0 de proceso
El pipeline `dependency-security` sirve de **gate de regresión**: en el SHA base `48504e3ad68c7c2acab38d4be78483e811ea8db1` pasó con backend `0 critical / 0 high / 6 moderate` y `releaseAccepted:false` porque `scripts/security-moderate-baseline.json` está marcado `unaccepted-for-release`. Hasta este cambio `scripts/production-preflight.sh` permitía pasar todas sus comprobaciones con un SHA y variable `DEPLOY:<SHA>` válidos **sin consultar el veto de seguridad**. CI verde no equivale a autorización de lanzamiento.

## Corrección de código ejecutable
- `scripts/verify-production-security.mjs` verifica el JSON de política y el `backend/package-lock.json` de la misma revisión. Exige `status=remediated`, `maxModerate=0`, `packages={}`, revisión UTC no caducada y que no sobreviva ninguna de las seis versiones vulnerables registradas. **No admite** flags `--force`, `SKIP_SECURITY`, texto de aprobación arbitrario ni `DEPLOY:<SHA>` como reemplazo.
- El `production-preflight.sh` lo ejecuta sin escritura, antes de Docker, migraciones o proxy, aun con SHA Git exacto y credenciales válidas. El `deploy-prod.sh` ya llama a este preflight, por lo tanto un despliegue iniciado con el candidato actual **queda BLOQUEADO**.
- El `scripts/security-moderate-policy.mjs` reconoce el estado futuro `remediated` **solamente** si el inventario y el resultado real de `npm audit` coinciden exactamente en **cero** moderadas. Un archivo de política alterado a `remediated` por sí solo hace **fallar el CI** mientras el registro npm reporte vulnerabilidades; la verificación adicional de versiones bloquea ocultamiento de los seis paquetes originales en preflight.
- La salida del escáner distingue claramente auditoría válida para seguir desarrollando de admisión para producción. Los hallazgos moderados vigentes **NO** se aceptan, ignoran ni declaran remediados.

## Pruebas
- `scripts/test/production-security-gate.test.mjs`: el baseline y lockfile **actuales** rechazan el GO; política falsa, fecha inválida/expirada, formato incompleto, cada versión vulnerable y CLI real sin acceso a red/BD.
- `scripts/test/production-preflight.test.mjs`: repos Git descartable con SHA+aprobación exactos y .env seguros; un baseline de seis advisories sigue impidiendo producción. Fixture positiva sintética de riesgo cero permite ejercitar el resto del preflight.
- `scripts/test/security-moderate-policy.test.mjs`: cero mitigado + reporte npm audit vivo se aceptan juntos; falsa aprobación con informes moderados **siempre** falla. El flujo de CI mantiene las cuatro pruebas reales: PostgreSQL/FORCE RLS/restauración, Chromium, Docker e inventario npm.

## Desbloqueo futuro
El próximo bloque **de remediación genuina** del issue #137 debe actualizar `backend/package.json`, `backend/package-lock.json` y, de ser necesario, la herramienta de migraciones/ORM. No tocar `umzug`/Sequelize a ciegas: es el motor de migraciones y tablas activas de producción. Pruebas obligatorias `npm ci`, `migrate/seed/status`, backup/restore, transacciones, rol runtime RLS y aceptación HTTP. Solo cuando `npm audit --omit=dev --json` informe **0 critical/high/moderate** en las mismas dependencias runtime del Docker, un PR revisado puede cambiar la política a `remediated/0` y volver a pasar el gate de seguridad. Los demás controles de staging, backup/restore real, móvil y rollback de #130 siguen siendo independientes.

Este control **no firma una decisión legal de riesgo ni comprueba por sí mismo que hubo QA/GO del staging**: solo rechaza el primer error de proceso, la confusión entre inventario aceptable para desarrollo y aprobación productiva.
