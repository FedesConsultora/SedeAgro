# SedeAgro 0.1 — Suspensión de una empresa frente a operaciones HTTP ya iniciadas

**Control P0 del piloto:** la suspensión de una empresa debe impedir que las transacciones de campo sigan confirmando cambios después de que sus sesiones fueron revocadas. Base revisada `main@d4c8c22acd7c0e4f58056c18082a28e74751d054`. Coordinación #18, release #130 `NO-GO`.

## Carrera comprobada mediante revisión de código

`tenantResolver` consulta la empresa *fuera* de la transacción de negocio. `tenantTransaction` abría la transacción y fijaba `app.current_tenant` pero no volvía a validar el estado de la empresa ni tomaba un bloqueo que coordinara con su suspensión. Así, una solicitud que había pasado el resolver con status activo podía comenzar a escribir después de que el administrador hubiera suspendido la empresa y revocado `auth_sessions`.

## Implementación

- Cada solicitud scoped toma, en su transacción PostgreSQL, un **advisory lock SHARED** por empresa *antes* de establecer el GUC tenant y consultar la sesión/rol. Relee `tenants.status IN ('active','onboarding')` en esa misma transacción. Si se había suspendido, responde `403 TENANT_DISABLED_DURING_REQUEST` sin montar rutas privadas ni enviar mutaciones.
- `PATCH /platform/tenants/:id` usa, al modificar status de una **empresa de destino diferente a la empresa del administrador**, un **advisory lock EXCLUSIVE** para esa empresa *antes* de tomar su lock de fila y antes de la revocación de sesiones. La suspensión queda esperando la finalización (commit o rollback) de las peticiones que ya adquirieron el lock SHARED.
- Los bloqueos `pg_advisory_xact_lock[_shared]` son **de transacción, no de sesión**: se liberan solos al terminar, también por error. Otras solicitudes del mismo tenant sólo toman SHARED, por lo que **no se serializan entre sí**. Las claves incluyen un namespace propio del producto y el UUID canonizado a minúsculas, para que las variantes con distinta capitalización no eludan el bloqueo. Las colisiones de `hashtext` agregan espera conservadora, pero no autorizan otra empresa.
- Las actualizaciones sólo de plan mantienen el control existente de fila y no requieren EXCLUSIVE sobre otra empresa. La auto-suspensión/auto-eliminación desde el tenant actual sigue prohibida por `tenantStatusPolicy`. `requireAuth`, cookies/JWT y FORCE RLS de `auth_sessions` no se relajan.
- **Garantía de orden:** si operación de campo toma SHARED primero, plataforma espera hasta que aquélla confirma o hace rollback y luego revoca las sesiones; si plataforma toma EXCLUSIVE primero, la petición scoped espera y tras suspenderse recibe 403 sin continuar su workflow.

## Pruebas de regresión

`backend/test/tenantSuspensionFence.test.js` comprueba SQL de bloqueo transaccional y orden antes de GUC/auth, exclusividad antes de UPDATE/revocación, y UUID canonizado.

`backend/test/tenantSuspensionRace.pg.mjs` ejecuta la API real con PostGIS descartable y rol runtime non-owner, tenant A operador de plataforma, tenant B usuario de campo. Primer escenario: intercepta la respuesta del resolver cuando B aún figura activa, suspende B desde la API plataforma y obliga al request a usar esa lectura obsoleta; exige `403 TENANT_DISABLED_DURING_REQUEST` y revocación persistente. Segundo escenario: intercepta `AuthSession.findOne` cuando una petición B ya adquirió el bloqueo SHARED y demuestra con otra conexión PostgreSQL que **no puede obtenerse un lock EXCLUSIVE**. Ejecuta suspensión, libera la petición, exige que ésta termine antes de que plataforma revoque el JTI y comprueba 401 del token tras reactivación. Incluye auditoría del tenant B.

## Limitaciones y aceptación

- Esta barrera cubre operaciones HTTP scoped que pasan por `tenantTransaction` y cambios de estado de empresa hechos por la ruta de plataforma coordinada. **SQL privilegiado directo**, workers fuera de esa cadena de middleware o mutaciones de tenants mediante otras rutas que no usen el EXCLUSIVE pueden saltarse este contrato; requerir procedimiento operativo y auditoría separados.
- Un administrador de plataforma activo en A que intente cambiar el estado de B mientras otro operador activo en B hace lo inverso puede provocar un *deadlock* de PostgreSQL entre SHARED de su propio tenant y EXCLUSIVE del destino; PostgreSQL aborta una transacción sin confirmar la suspensión. Exigir manejo operativo/reintento y revisar topología de administradores antes de escalar; no se afirma ausencia de deadlock.
- Es una operación transaccional con espera explícita: medir el tiempo de suspensión bajo cargas HTTP largas en staging; si hay operación de campo abierta, la suspensión no se considera completada hasta el ACK.
- Sigue pendiente un diseño seguro para FORCE RLS de `memberships` (#232) y arranque offline #163. Staging autorizado y Android Chrome/iOS Safari físicos `NOT_RUN`; **release #130 NO-GO**. No se desplegó ni modificó una base productiva.
