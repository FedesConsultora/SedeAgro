# Piloto 0.1 — Suspensión de empresas sin resurrección de cookies/JWT

**Alcance:** endpoint existente `PATCH /api/v1/platform/tenants/:id`. No se modifica esquema ni se opera sobre producción. Base `main@33468f0078efdba0703280b490aea1704b7b4bbb`; coordinación #18; aceptación #130 NO-GO.

## Riesgo

Antes de este bloque, el administrador de plataforma podía cambiar `tenants.status` a `suspended` o `deleted` sin revocar `auth_sessions`. Mientras el tenant estuviera suspendido, `tenantResolver` negaba sus rutas; al reactivarlo, una cookie/JWT no expirado podía volver a funcionar.

## Nuevo contrato

- El acceso sigue exigiendo una sesión activa y `is_platform_admin === true`. Admin de empresa y roles no privilegiados reciben 403.
- La transición toma `SELECT FOR UPDATE` de la empresa de destino dentro de la transacción HTTP. Si suspende o marca `deleted`, primero actualiza `tenants.status`, luego cambia temporalmente `app.current_tenant` al destino y revoca **todas las sesiones persistidas del tenant** bajo FORCE RLS de `auth_sessions`; el ámbito original se restaura en `finally`.
- No se permite suspender/eliminar desde el contexto de esa misma empresa, evitando que el único administrador disponible se autoexpulse. Una empresa `deleted` es terminal para esta ruta: no se reactiva con un simple cambio de estado.
- Las operaciones de plan-only no revocan sesiones. Repetir suspensión ejecuta reconciliación de sesiones persistidas residuales sin recrear JWT; sin mutación ni nuevas sesiones, el resultado es idempotente.
- En la misma transacción se agrega evento `platform.tenant.lifecycle_updated` con antes/después de estado y plan y cantidad de sesiones revocadas. No se registran tokens, cookies, emails ni datos de lotes. La respuesta es `private, no-store`.
- La revocación se confirma antes de enviar HTTP ACK. Las nuevas sesiones después de la reactivación son legítimas, pero las anteriores continúan revocadas.

## Evidencia

`backend/test/tenantStatusPolicy.test.js` valida estados prohibidos, autoexpulsión, lock y orden de GUC/UPDATE/auditoría.

`backend/test/platformTenantSuspension.pg.mjs` se ejecuta en PostGIS descartable con rol runtime no-owner. Utiliza empresa A (admin de plataforma y scout sin privilegios) y B (operador). Prueba token Bearer+Cookie emitidos por login real, cambio de plan sin revocación, suspensión de B con revocación de tres sesiones, 403 durante suspensión, 401 definitivo luego de restaurar, acceso legítimo sólo con nuevo login y aislamiento RLS de sesiones frente a A. También verifica auditoría, repetición idempotente, soft delete terminal y la integridad del ámbito de A.

## Pendiente de aceptación para producción

No sustituye la revisión integral de autorizaciones de plataforma ni el diseño de FORCE RLS para `memberships` (#232). Cambios directos realizados por el DBA con SQL que eludan este endpoint **no** obtienen revocación automática, por lo que se requiere procedimiento operativo restringido. Autorización de staging, pruebas móviles reales y GO/NO-GO #130: **NOT_RUN / NO-GO**.
