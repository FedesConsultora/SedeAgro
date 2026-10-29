# 0U — Puente HTTP real entre alta y primera recorrida (#166)

**Fecha:** 29/10/2026. **Entorno:** GitHub Actions, PostgreSQL 16 + PostGIS **descartable** con roles owner y runtime distintos; **no** staging, **no** Android/iOS físicos. **Release #130: NO-GO.**

## Hueco encontrado

`backend/test/pilotCriticalPath.pg.mjs` ya completa el recorrido desde recorrida/observación GPS/foto offline hasta orden, ejecución, revisión independiente y exportaciones CSV/PDF/XLSX **contra Express+PostGIS reales**. Sin embargo prepara usuarios, membresías, establecimientos, lotes y campañas directamente mediante SQL de dueño de base, sin probar el encadenamiento de endpoints públicos y administrativos que usaría un operador durante la puesta en marcha del piloto. Los tests individuales `memberInvitations.pg.mjs`, `teamFarmCreation.pg.mjs`, `campaignCreateIdempotency.pg.mjs`, `campaignFieldAssignIdempotency.pg.mjs` y `scoutingRunCreateIdempotency.pg.mjs` validan cada módulo, pero no verificaban que una **identidad invitada realmente pudiera ser asignada a una recorrida de una campaña recién creada por UI/API**.

## Ensayo integrado agregado

El archivo `backend/test/pilotActorOnboarding.pg.mjs` se descubre automáticamente con `npm run test:db`. Su ruta es: registrar dos empresas distintas por `POST /auth/register-tenant` → cookie HttpOnly/SameSite Strict persistida → crear invitaciones a scout y productor → comprobar token de entrega manual una sola vez y ausencia del secreto en listados → aceptar, probar reutilización bloqueada y hacer login con contraseña personal → verificar `GET /auth/me` → crear productor, establecimiento, lote GeoJSON WGS84 válido, campaña, asignación campo–campaña y recorrida asignada **a través de HTTP**, sin SQL privilegiado para crear esas entidades.

Comprobaciones adicionales: bloqueo CSRF de cookie sin cabecera `x-sedeagro-request`, rol scout no puede crear lote/campaña, GeoJSON auto-intersectado devuelve 422, relación con productor extranjero 404, UUID de campaña/lote/recorrida repetido devuelve la **misma** entidad sin duplicados, tenant B no puede leer ni asignar objetos de tenant A, productor no ve lotes sin permiso expreso y su grant otorgado/revocado impacta el mismo `GET /fields`, productor no adquiere permisos scouting/campañas, administrador bloquea al scout y la cookie previamente válida devuelve 401. Verificación SQL final comprueba una única cadena de FK, estatus bloqueado y aislamiento FORCE RLS en una conexión PostgreSQL no propietaria.

El test no genera tokens de sesión con `signSession` ni omite persistencia `auth_sessions`. Sólo usa SQL owner para **verificar** aislamiento y limpiar las empresas de prueba. Ni los secretos de invitación ni cookies se imprimen en logs.

## Alcance y pendientes

- Este nuevo puente **no** sustituye `pilotCriticalPath.pg.mjs`, que prueba la segunda mitad de observación→sincronización→evidencia→OT→reporte. Mantener ambos evita duplicar cada subcaso con dos actores diferentes.
- Es prueba integración real HTTP/DB, **no** navegación React de un usuario físico ni una sesión real con servidor público; las cookies son reales emitidas por Express sobre localhost.
- Validar en staging autorizado las cinco identidades del piloto, invitación entregada manualmente y aceptada, GPS/cámara reales, revocación, fotografía privada y continuidad offline. Documentar IDs/requests anonimizados, sin secretos ni PII.
- Android Chrome e iOS Safari siguen **NOT_RUN**. Security Owner, Product Owner, Operations/Data y rendimiento staging #143 son firmas externas. #163 requiere QA física cold-start offline; #232 revisión independiente RLS/benchmarks de selector multiempresa.
- **No hay permiso para deployment, VPS, uso de datos reales, modificación de la política de release ni certificación de staging.**
