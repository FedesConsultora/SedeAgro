# SedeAgro 0.1 — Bloquear una cuenta global sin revivir sesiones anteriores

**Base de desarrollo:** main@0d76dacdd02d7dcbe86b4f7cce6e03c1b88ba3d2. Relacionado con PR #242, issue #232 y GO/NO-GO #130.

## Riesgo que resuelve

El login ahora rechaza `users.status != active`. Sin embargo, simplemente cambiar `users.status` mediante SQL o actualizarlo sin revocar `auth_sessions` deja JWTs previamente emitidos como `revoked_at=null`. Mientras el usuario está bloqueado, `requireAuth` los rechaza, pero al reactivar su cuenta podrían volver a ser utilizables antes de su expiración natural. En dos empresas esto deja cookies/sesiones persistidas en múltiples tenants.

## Contrato del endpoint

`PATCH /api/v1/platform/users/:userId/status`, body estricto `{"status":"blocked"}` o `{"status":"active"}`, exige autenticación con `is_platform_admin===true`; no sirve para administradores de una sola empresa, scouts ni usuarios sin sesión.

- Sólo se gestiona una cuenta **no** administradora de plataforma. La cuenta del actor y cualquier administrador de plataforma están protegidos contra suspensión accidental. No se elimina la cuenta ni se reactivan cuentas `deleted` mediante este flujo.
- Se bloquea el registro del usuario mediante `SELECT ... FOR UPDATE`, dentro de la misma transacción que utiliza el middleware HTTP. Es el mismo lock que usa `reserveSessionSlot` al emitir un login nuevo: ni una suspensión ni un login pueden adelantarse a la otra sin orden transaccional.
- Para `blocked`, la ruta de plataforma autorizada enumera **todos los IDs de tenant**, no sólo las membresías actuales: pueden persistir JWT antiguos de empresas cuya membresía se eliminó. Se fija transaccionalmente `app.current_tenant` para cada tenant y se revocan sus `auth_sessions` mediante una `UPDATE` que sigue sometida a FORCE RLS. Se restaura `app.current_tenant` al tenant original incluso si un paso falla. La operación es intencionalmente O(cantidad de tenants) por tratarse de una suspensión global excepcional; requiere medición en staging antes de escalar su uso.
- La actualización de estado, las revocaciones y el registro `platform_audit_logs` se confirman **antes** de transmitir la respuesta HTTP. Fallos revierten toda la transacción. La respuesta no expone tokens, correos ni nombres.
- Repetir un bloqueo ya aplicado es idempotente y reintenta revocar cualquier sesión antigua no revocada. Reactivar sólo cambia `users.status`; **no** borra `revoked_at`, por lo que cookies/JWT viejos no recuperan privilegios; se debe iniciar sesión de nuevo.
- Audit event `platform.user.global_status_changed`: ID interno, estado anterior, estado posterior y cantidad total de sesiones revocadas. Ninguna contraseña, token ni evidencia fotográfica queda en la auditoría.

## QA

`backend/test/globalUserStatusPolicy.test.js` prueba estado/actor/usuario protegido, lock, orden de operaciones, restauración de GUC y ruta privilegiada.

`backend/test/platformGlobalUserLifecycle.pg.mjs` usa PostGIS de CI desechable y rol runtime non-owner, con admin plataforma, usuario común en **tres empresas** y scout no privilegiado. Una membresía de la tercera empresa se elimina después de emitir la sesión para simular un JWT huérfano. Emite sesión real de backend para cada tenant; suspende globalmente; verifica HTTP 401 de los tres JWT y que `revoked_at` queda escrito en los tres tenants, incluso el de la membresía ya eliminada. Rechaza admin/scout y payload inválido, comprueba RLS no-owner entre tenants, repetición idempotente, reactivación sin resurrección de JWT, restitución de la membresía eliminada sin recuperar el JWT huérfano y nuevo login legítimo. Comprueba auditoría y `deleted` no reactivable.

## Fuera de alcance

- **#232:** `memberships` no tiene FORCE RLS: la enumeración actual funciona exclusivamente en ruta de plataforma controlada, pero no es una solución ni una política RLS nueva para esa tabla. Debe diseñarse compatibilidad con login multiempresa por separado.
- Cambios directos de estado global mediante SQL privilegiado sin usar este endpoint no obtienen automáticamente la garantía de revocación. El procedimiento operativo debe requerir este flujo o una migración futura auditada.
- Sin correo de invitación, sin deploy, sin validación Android/iOS ni staging: `RELEASE_0_1=NO_GO` hasta completar aceptación física en #130.
