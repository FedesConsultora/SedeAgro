# Piloto SedeAgro 0.1 — rechazo de login para cuentas globalmente bloqueadas

**Incidente de coherencia de autorización detectado en main@8c6f37733dc19b7236af56fadb706cb1b636dd9a**. El backend diferencia el estado global `users.status` (`active`, `blocked`, `deleted`) del estado de cada `memberships.status`. El middleware `requireAuth` ya rechazaba cuentas no activas en cada solicitud protegida, pero `POST /auth/login` sólo verificaba contraseña y membresías: un usuario globalmente bloqueado con membresías activas podía obtener `requiresTenantSelection` y emitir nuevos JWT/cookies y filas `auth_sessions`.

## Contrato corregido

- La contraseña se sigue comprobando antes de responder. Para email, contraseña o estado global incorrectos la respuesta sigue siendo el mismo `401` opaco (`Email o contraseña incorrectos.`); no se enumeran tenants en ese caso y no se configura una cookie.
- La cuenta debe tener `status === 'active'` independientemente de cuántas empresas tengan una membresía local activa. Una cuenta `blocked`, `deleted` o estado desconocido no puede llegar al selector de empresas ni a emisión de sesión.
- La operación que reserva cupo y crea sesión bloquea `users` mediante `SELECT ... FOR UPDATE`, **relee** `status` y rechaza antes de revocar las sesiones antiguas o guardar una nueva. Impide una carrera entre verificación pública previa y cambio de estado global confirmado en PostgreSQL.
- Usuarios globalmente activos conservan el login multiempresa normal y el transporte de cookies HttpOnly o Bearer. Registro de empresa nueva también usa la misma comprobación transaccional.

## Evidencia automática requerida

- `backend/test/loginAccountPolicy.test.js`: política de estado activa únicamente y orden exacto de validaciones, incluida la barrera bajo lock en `reserveSessionSlot`.
- `backend/test/loginAccountStatus.pg.mjs`: PostGIS disposable con rol runtime non-owner, dos empresas y dos membresías activas, login con selección de tenant, sesiones Bearer y Cookie, bloqueo global y `deleted` con contraseña correcta: siempre 401 sin lista de empresas, nueva cookie, JWT ni `auth_sessions`; sesiones ya emitidas rechazadas por `/auth/me` mientras cuenta bloqueada; activación global posterior permite nuevo login.
- El resto de pruebas tenant-RLS/login/invitaciones y compilación deben permanecer verdes.

## Riesgos restantes: no confundir mitigación con certificación

- **Issue #232 permanece abierto:** `memberships` no posee ENABLE/FORCE RLS; una migración ciega quebraría el selector multiempresa. Este bloque no cambia permisos ni políticas SQL.
- Un cambio de `users.status` hecho directamente por SQL fuera de un flujo con revocación persistente podría dejar una sesión anterior reutilizable **si el usuario vuelve a estar activo antes de que expire**. Para una garantía definitiva hace falta ciclo de vida global con revocación de sesiones de todas las empresas; este bloque sólo impide **nuevas** sesiones mientras no está activo y exige revalidación en solicitudes protegidas.
- No hay staging ni dispositivos físicos ejecutados. Los controles CI no autorizan deploy; release issue #130 sigue `NO-GO`. Para aceptación real: bloquear desde administración, intentar nuevo login en dos empresas y repetir sobre Chrome Android y Safari iOS.
