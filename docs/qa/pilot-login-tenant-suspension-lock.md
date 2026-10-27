# SedeAgro 0.1 — carrera entre suspensión de empresa e inicio de sesión

**Base:** main `180e4973733225ee2ad0ed8568c411581abf3217`. Coordinación #18, seguridad #232 (pendiente), aceptación #130 (NO-GO).

## Defecto de producción mitigado

El endpoint privilegiado `PATCH /platform/tenants/:id` ya tiene `SELECT FOR UPDATE` de la empresa y revoca `auth_sessions` con FORCE RLS al suspenderla. Sin embargo `issueTenantSession`, usado por login y registro, previamente hacía `Membership SELECT FOR UPDATE` y después consultaba `Tenant` **sin lock**. Si el estado de la empresa cambiaba y sus sesiones eran revocadas entre la comprobación de estado y la creación del JTI, una nueva cookie/JWT podía insertarse después de la revocación y volver a funcionar tras la reactivación.

## Nuevo orden transaccional

`issueTenantSession` obtiene primero `Tenant SELECT FOR UPDATE` para el ID recibido desde la membresía previamente autenticada, exigiendo `active|onboarding`; luego `Membership SELECT FOR UPDATE` con ID+empresa+usuario+estado activo; finalmente, `reserveSessionSlot` bloquea la cuenta global para limitar sesiones. No se usa la membresía descubierta públicamente como permiso para firmar el JWT: su rol se relee bajo lock.

**Dos órdenes de carrera:**

- Si el login bloquea la empresa primero, la suspensión de plataforma espera, después actualiza estado y revoca también la nueva sesión antes de confirmar su HTTP.
- Si la suspensión bloquea la empresa primero, el login espera y, tras confirmarse la suspensión, el `SELECT FOR UPDATE` con estado activo no encuentra una empresa válida: devuelve `403 LOGIN_TENANT_DISABLED`, sin JTI, `auth_sessions` ni cookie.

No se usa un lock exclusivo de Redis ni una variable de proceso: la coordinación funciona entre réplicas que comparten PostgreSQL y se apoya en commit/rollback del middleware HTTP.

## QA del piloto

- `backend/test/loginTenantLockOrder.test.js` exige orden de bloqueos transaccionales y conexión con la operación de suspensión.
- `backend/test/loginTenantStatusRace.pg.mjs` usa HTTP real, PostGIS descartable y rol runtime non-owner. Intercepta exclusivamente la respuesta inicial `Membership.findAll` del login de un usuario objetivo; tras recibir la membresía+empresa originalmente activa ejecuta un PATCH de suspensión **real desde un administrador de plataforma en otra empresa**. Entrega después al login su lectura anterior y exige `403`, cero sesiones nuevas y ninguna cookie; comprueba que reactivar no revive ese intento y que un login nuevo legítimo funciona, junto con dos eventos de auditoría en la empresa correcta.
- La CI debe seguir pasando registro-tenant, invitaciones, selección multiempresa, cookie/CSRF, fuerza RLS de `auth_sessions`, PostGIS de dos empresas e imágenes.

## Límites

No se habilita FORCE RLS en `memberships` (issue #232), ni se presupone que un tenant no-owner pueda leer datos de otra empresa. Cambios directos de estados por SQL con roles privilegiados fuera del endpoint autorizado pueden seguir saltándose el flujo de revocación. La validación física Android Chrome/iOS Safari y staging autorizado están `NOT_RUN`; no hay autorización de deploy ni certificación de release #130.
