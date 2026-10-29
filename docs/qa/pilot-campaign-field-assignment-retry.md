# Piloto 0.1 — Asignación lote↔campaña resistente a ACK perdido (#257)

## Brecha confirmada en main de 29/10/2026

`POST /api/v1/campaigns/:campaignId/fields` creaba la asociación en `campaign_fields` pero no almacenaba `client_request_id`; si había COMMIT sin respuesta, el operador no podía distinguir un enlace ya creado de una solicitud fallida. El índice `UNIQUE (tenant_id,campaign_id,field_id)` bloqueaba duplicados pero no proveía identidad de reintento. `AssignFieldModal` informaba incertidumbre sin recuperación tras cerrar el navegador.

## Contrato nuevo

- **Creación:** `client_request_id` UUID opcional, para preservar compatibilidad HTTP de clientes anteriores. El servidor valida permisos `campaigns.write`, tenant, campaña, lote, cultivo/variedad y fechas antes de persistir. El identificador nunca es un token de autenticación.
- **Acuse durable:** nueva tabla `campaign_field_assign_requests` con `(tenant_id,requested_by,client_request_id)` PK, fingerprint SHA-256 de parámetros agronómicos canónicos y `campaign_id`, y FK compuesta de `campaign_field_id`. Habilita y obliga FORCE RLS; sin política runtime DELETE. El registro y la asociación se confirman en la misma transacción de tenant.
- **Respuesta:** primera asignación `201 {data,replayed:false}`; mismo actor+tenant+UUID+contenido `200 {data,replayed:true}`; UUID con datos o campaña distintos `409 CAMPAIGN_FIELD_REQUEST_CONFLICT`; distinta clave/actor sobre pareja campaña/lote existente `409 CAMPAIGN_FIELD_ALREADY_ASSIGNED`; recurso eliminado deja tombstone y responde `409 CAMPAIGN_FIELD_RESULT_GONE`. `Cache-Control: private, no-store`.
- **Concurrencia:** la primary key del acuse serializa el reintento concurrente entre workers; la constraint única de campaña/lote sigue siendo la identidad funcional. No se retorna éxito a otra clave por coincidir el lote.
- **Interfaz:** primero cifra el request original (AES-GCM con clave no extraíble y AAD ligado a scope y UUID) y confirma IndexedDB; sólo después envía POST. Un error local impide el envío. Tras timeout o ACK contradictorio no genera una segunda clave. Al reabrir el formulario y con sesión/rol/empresa/campaña válidos restaura el request y permite **reintento manual exacto**, sin POST automático. Descartar exige confirmar antes que se revisó el listado. Ningún dato privado de otra sesión se presenta ni puede borrar el journal activo.
- **Compatibilidad:** el backend sigue aceptando solicitudes sin `client_request_id` y las procesa con respuesta 201 tradicional; no se migran borradores offline ni datos existentes. El journal es independiente de creación de campañas, recorridas, órdenes y observaciones.

## Evidencia / criterios de aceptación

- `backend/test/campaignFieldAssignIdempotency.pg.mjs`: HTTP Express real con usuario PostgreSQL no-owner, dos empresas, 403, 404, 422, 409 con otra clave/actor/cuerpo, concurrencia exacta 201+200, recuento sin duplicados, cache privado, mutación posterior y tombstone.
- `frontend/test/campaignFieldAssignRecovery.test.js` más `campaignFieldAssignSafety.test.js`: scope de sesión, validación UUID, bloqueo doble click, journal cifrado-before-network, recuperación/descartar por acción explícita y ACK ligado a campaña, lote y tenant.
- Gate premerge: CI exact SHA 5/5 (tenant-rls, browser-postgis real, browser-offline, production-images, dependency-security). Postmerge: 7/7 independientes, incluyendo OCI attestation+import.
- Aceptación física pendiente: crear lote→campaña con red real, interrumpir respuesta tras COMMIT, cerrar/reabrir navegador, reintentar mismo UUID, revisar duplicados cero; cambiar empresa y miembro; usuario suspendido no puede consultar. No se confunde CI con aceptación en el dispositivo.
- **Seguridad release:** issue #232 (memberships sin FORCE RLS), #163 (cold start sin red), #130 (NO-GO) siguen pendientes. No staging o producción, credenciales reales, DB productiva, cambios de infraestructura ni acceso remoto.
