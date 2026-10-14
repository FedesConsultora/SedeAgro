# Bloque 0D: atomicidad HTTP y sesiones bajo RLS

## Contrato de transacción por request

Las rutas públicas `/api/v1/auth/login` y `/api/v1/auth/register-tenant` administran sus propias consultas/transacciones. Las rutas autenticadas con tenant resuelto utilizan `tenantTransaction` y el contexto RLS transaccional.

Antes del bloque 0D, el backend confirmaba o revertía la transacción *al terminar de transmitir la respuesta*. Un error tardío de commit podía dejar al cliente con un HTTP 200/201 sin una escritura confirmada.

Desde este cambio, `transactionalResponse.js` aplica las siguientes reglas:

- Para cualquier respuesta con estado inferior a 400, confirma la transacción **antes** de transmitir el cuerpo o las cabeceras finales.
- Para estados 4xx y 5xx, revierte la transacción **antes** de responder con el error.
- Si el commit falla, invalida el cuerpo y las cabeceras preparadas, informa el error al middleware central y responde con HTTP 500 (cuando la conexión sigue abierta). No publica una respuesta 2xx ficticia.
- Si se interrumpe la conexión antes de preparar una respuesta, ejecuta rollback.
- Se rechaza el envío anticipado mediante `res.write()`, `res.writeHead()` o `res.flushHeaders()` con error, sin transmitir datos. Las rutas scoped solo admiten, por ahora, respuestas pequeñas emitidas mediante `res.json()` / `res.send()` / `res.end()`.
- El middleware registra fallas de confirmación y reversión mediante el logger estructurado; no imprime SQL ni secretos.

**Limitación de concurrencia:** si el cliente cancela una conexión mientras ya se está ejecutando el commit, no se puede garantizar deshacerlo. Las escrituras no son idempotentes por definición: los clientes no deben reintentar un POST sin conocer el resultado; se deberá añadir una clave idempotente donde corresponda.

## Cuentas y módulos en auth

`tenant_modules` utiliza `FORCE ROW LEVEL SECURITY`. Para impedir que registro y login devuelvan permisos vacíos o fallen bajo el rol no privilegiado:

- `register-tenant` establece `setLocalTenant(transaction, tenant.id)` antes de insertar los `TenantModule` iniciales.
- `login` obtiene los entitlements dentro de `withTenantTransaction(..., membership.tenant_id)`.
- `/auth/me` sigue utilizando la transacción contextual de la solicitud autenticada.

La suite PostgreSQL desechable valida la secuencia real `register-tenant → login → /auth/me` con credenciales de aplicación restringidas y comprueba que los entitlements coincidan en las tres respuestas.

## Validación

```bash
npm --workspace backend run test
npm --workspace backend run test:db  # Solo una base PostgreSQL/PostGIS desechable y migrada
```

`test:db` exige `TEST_DATABASE_ADMIN_URL` y `TEST_DATABASE_APP_URL`. La prueba de auth usa esas URLs y genera datos transitorios únicamente en bases con `test` en el nombre. GitHub Actions ejecuta ambas suites en cada PR.

## Pendientes de arquitectura

- Streaming / grandes descargas deben usar un flujo externo al middleware de respuesta transaccional, con snapshot/consulta finalizada antes de abrir el stream.
- Aislamiento de tablas globales `memberships` y `tenant_modules` requiere separación de responsabilidades, grants SQL y diseño explícito de soporte/plataforma. No se resolvió aquí.
- Se requieren permisos por establecimiento para productores, scopes por lote y auditoría de transiciones de órdenes.
- Desplegar en VPS requiere primero el procedimiento y variables del Bloque 0C (ver `docs/security/postgres-rls-runbook.md`).
