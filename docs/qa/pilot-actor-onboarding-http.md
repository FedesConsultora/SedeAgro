# 0U — Cadena HTTP real de actores: empresa → campo → ejecución → reporte (#166)

**Fecha:** 29/10/2026. **Entorno:** GitHub Actions, PostgreSQL 16 + PostGIS **descartable** con roles owner y runtime distintos; **no** staging, **no** Android/iOS físicos. **Release #130: NO-GO.**

## Hueco encontrado

`backend/test/pilotCriticalPath.pg.mjs` ya completa el recorrido desde recorrida/observación GPS/foto offline hasta orden, ejecución, revisión independiente y exportaciones CSV/PDF/XLSX **contra Express+PostGIS reales**. Sin embargo prepara usuarios, membresías, establecimientos, lotes y campañas directamente mediante SQL de dueño de base, sin probar el encadenamiento de endpoints públicos y administrativos que usaría un operador durante la puesta en marcha del piloto. Los tests individuales `memberInvitations.pg.mjs`, `teamFarmCreation.pg.mjs`, `campaignCreateIdempotency.pg.mjs`, `campaignFieldAssignIdempotency.pg.mjs` y `scoutingRunCreateIdempotency.pg.mjs` validan cada módulo, pero no verificaban que una **identidad invitada realmente pudiera ser asignada a una recorrida de una campaña recién creada por UI/API**.

## Ensayo integrado agregado

El archivo `backend/test/pilotActorOnboarding.pg.mjs` se descubre automáticamente con `npm run test:db`. Su ruta es: registrar dos empresas distintas por `POST /auth/register-tenant` → cookie HttpOnly/SameSite Strict persistida → crear invitaciones a scout y productor → comprobar token de entrega manual una sola vez y ausencia del secreto en listados → aceptar, probar reutilización bloqueada y hacer login con contraseña personal → verificar `GET /auth/me` → crear productor, establecimiento, lote GeoJSON WGS84 válido, campaña, asignación campo–campaña y recorrida asignada **a través de HTTP**, sin SQL privilegiado para crear esas entidades.

Comprobaciones adicionales: bloqueo CSRF de cookie sin cabecera `x-sedeagro-request`, rol scout no puede crear lote/campaña, GeoJSON auto-intersectado devuelve 422, relación con productor extranjero 404, UUID de campaña/lote/recorrida repetido devuelve la **misma** entidad sin duplicados, tenant B no puede leer ni asignar objetos de tenant A, productor no ve lotes sin permiso expreso y su grant otorgado/revocado impacta el mismo `GET /fields`, productor no adquiere permisos scouting/campañas, administrador bloquea al scout y la cookie previamente válida devuelve 401. Verificación SQL final comprueba una única cadena de FK, estatus bloqueado y aislamiento FORCE RLS en una conexión PostgreSQL no propietaria.

El test no genera tokens de sesión con `signSession` ni omite persistencia `auth_sessions`. Sólo usa SQL owner para **verificar** aislamiento y limpiar las empresas de prueba. Ni los secretos de invitación ni cookies se imprimen en logs.

## Ampliación del piloto 0U: mismo expediente, seis actores HTTP reales

La suite ahora incorpora **contratista y coordinador** mediante el mismo flujo de invitación de siete días y login con cookie registrada, no con JWT sintético. El scout invitado crea una observación WGS84/Point mediante `POST /sync/batches`, reintenta el mismo `idempotency_key` con idéntico `observation_id`, adjunta una foto JPEG privada y verifica la descarga autorizada. El contratista no puede reproducir el lote de sincronización del scout, y la empresa B recibe 404 al descargar fotografía ajena.

Sobre **ese mismo field_id + campaign_field_id** (sin inventar una FK directa inexistente entre observación y OT), el administrador crea una orden de inspección con `client_request_id`, reintenta el ACK exacto, asigna al contratista invitado y transiciona `draft → pending_approval → approved → assigned`. Sólo ese contratista ve la orden asignada e inicia `in_progress`. El backend rechaza cierre sin parte verificado, declaración duplicada de ejecución y revisión por contratista; exige foto privada antes de aprobar `evidence_basis: reviewed_files`. El contratista adjunta un JPEG de ejecución con UUID de carga idempotente, el coordinador independiente comprueba bytes e integridad y verifica con checklist, y el administrador cierra. CSV/PDF/XLSX del mismo lote deben contener **exactamente una observación y una OT**, formatos binarios válidos y acceso restringido. La matriz comprueba asimismo denegación de reportes para contratista y empresa B, y revocación posterior de sesiones reales de scout y contratista.

**Criterio de aceptación técnico:** el mismo ensayo conectado no usa SQL privilegiado para crear ninguna empresa, actor, membresía, lote, campaña, recorrida, observación, JPEG, OT, ejecución o reporte. SQL owner únicamente inspecciona vínculos, cantidades, revisión y GPS persistidos para garantizar que no se duplicaron; el runtime PostgreSQL **no propietario** comprueba FORCE RLS bajo tenant A/B para recorrida, observación, orden, ejecución y dos evidencias. Las firmas de pruebas están asociadas a la CI exact-head, nunca a ejecución física.

## Alcance y pendientes

- El puente ahora prueba la cadena completa con cuentas **emitidas y aceptadas realmente vía API**. `pilotCriticalPath.pg.mjs` se mantiene como regresión de reglas de detalle con fixtures SQL, no como requisito adicional de aceptación física. La ampliación no crea otro servidor ni otra suite desde cero.
- Es prueba integración real HTTP/DB, **no** navegación React de un usuario físico ni una sesión real con servidor público; las cookies son reales emitidas por Express sobre localhost.
- Validar en staging autorizado las identidades del piloto, invitación entregada manualmente y aceptada, GPS/cámara reales, revocación, fotografía privada y continuidad offline. Documentar IDs/requests anonimizados, sin secretos ni PII.
- Android Chrome e iOS Safari siguen **NOT_RUN**. Security Owner, Product Owner, Operations/Data y rendimiento staging #143 son firmas externas. #163 requiere QA física cold-start offline; #232 revisión independiente RLS/benchmarks de selector multiempresa.
- **No hay permiso para deployment, VPS, uso de datos reales, modificación de la política de release ni certificación de staging.**


### Estado de ejecución separado

| Entorno | Estado | Puede certificar |
| --- | --- | --- |
| CI descartable PostGIS + Express no-owner | PENDIENTE hasta comprobar el SHA exacto de PR y main | HTTP real, contratos, FORCE RLS, SQL de trazabilidad |
| Staging privado autorizado HTTPS | NOT_RUN | Perfiles, proveedor de invitación manual, despliegue y datos aislados |
| Android Chrome / iOS Safari físicos | NOT_RUN | GPS, permisos cámara, foto HEIC/JPEG, reinicio PWA, offline rural |
| Operación / seguridad / producto | NO-GO | Firma explícita #130, rollback, privacidad y acceso físico |

