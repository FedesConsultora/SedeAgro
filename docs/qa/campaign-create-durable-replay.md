# Piloto — Idempotencia persistente al crear campañas (bloque #211)

**Cadena:** empresa → establecimiento/lote → campaña. Base `main@acae82c332fb86649d555026261c9fd161707964`, coordinación #18, aceptación #166. No implica GO productivo (#130).

## Situación previa comprobada

`POST /campaigns` ejecutaba `Campaign.create(req.body)` en cada intento, sin devolver el identificador previamente confirmado después de una pérdida de respuesta. La protección de `CampaignFormModal` del PR #208 sólo cubría su propia apertura.

**Corrección de una premisa de la issue #211:** la tabla ya tiene `UNIQUE(tenant_id,name)` desde `202606160003_create_domain_schema.js`. Esto impide duplicados con el mismo nombre en una misma empresa, pero no equivale a una clave de solicitud persistente: ante un ACK perdido, repetir el nombre puede devolver error sin identificar la campaña original, y un cambio de nombre puede crear otra entidad. El alcance de este PR NO altera esa unicidad ni permite dos campañas con el mismo nombre actual.

## Contrato nuevo compatible hacia atrás

`POST /api/v1/campaigns` admite `client_request_id: UUID` **opcional**. El cliente antiguo sin esa propiedad continúa recibiendo HTTP 201 con `data`.

Para una petición con UUID:

1. La validación Zod y autorización `campaigns.write` ocurren antes de reservar o leer una clave.
2. La clave primaria `(tenant_id, requested_by, client_request_id)` serializa peticiones simultáneas en PostgreSQL bajo la transacción con `FORCE RLS`.
3. El fingerprint SHA-256 vincula exactamente los campos de creación ya normalizados: nombre, año, fecha de inicio y fin, estado. No incluye cookies, secretos ni el token de creación.
4. El primer POST confirmado devuelve HTTP **201** con `{data, replayed:false}`; reintento por el **mismo actor y la misma empresa y payload** devuelve HTTP **200** con `{data, replayed:true}` e idéntico UUID de campaña.
5. Reutilizar una clave con contenido alterado produce **409 CAMPAIGN_CREATE_REQUEST_CONFLICT**; no reescribe campañas anteriores. El cliente no puede presentar la clave de otro actor/tenant como autorización.
6. Si se borra la campaña, el FK compuesto `(tenant_id,campaign_id)` aplica `ON DELETE SET NULL(campaign_id)` y mantiene la clave como tombstone; reintentar responde **409 CAMPAIGN_CREATE_RESULT_GONE**, no recrea la campaña.
7. La respuesta lleva `Cache-Control: private, no-store` y no revela detalles de un usuario anterior. Los permisos/membresía actuales siguen siendo obligatorios en cada reintento.

## Evidencia y pruebas

- Migración `backend/db/migrations/202610250001_campaign_create_requests.js`: PK compuesta, FK tenant-bound, índice parcial, ENABLE + FORCE RLS, políticas SELECT/INSERT/UPDATE y sin DELETE de runtime; migración hacia atrás rechaza borrar recibos existentes.
- `backend/src/modules/campaigns/createIdempotency.js`: fingerprint, reserva atómica, lectura de recibo y finalización ligada a la fila real.
- `backend/src/modules/campaigns/router.js`: campo opcional, reserva antes de crear, replay sin escrituras laterales.
- `backend/test/campaignCreateIdempotency.pg.mjs`: pruebas reales de HTTP+PostgreSQL migrado y sembrado en `*_test`, usuario DB no owner, FORCE RLS, rol sin permiso, fecha inválida, request normal, replay, conflicto, actor/tenant aislados, envíos simultáneos, cliente legacy, actualización posterior, revocación y tombstone.

## Lo que NO cierra este PR

El frontend `CampaignFormModal` no genera ni conserva aún `client_request_id`; por ende **todavía no aprovecha** esta idempotencia después de timeout/refresh. Ese bloque UI necesita PR separado con recuperación protegida por identidad, y debe reutilizar exactamente el mismo cuerpo. El endpoint tampoco permite dos campañas con igual nombre en un tenant; si el producto requiriera ese caso, abrir diseño de dominio separado, no eliminar silenciosamente UNIQUE.

No se toca `main` sin 4/4 controles exactos ni se declara certificación de posmerge sin 6/6. No hay deploy, credenciales reales, staging ni prueba física (NOT_RUN). Release #130 sigue **NO-GO**; P0 #222 incorporación de usuarios y P1 #163 desbloqueo offline se mantienen abiertos.
