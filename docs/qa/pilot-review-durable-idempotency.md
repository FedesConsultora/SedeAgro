# Piloto SedeAgro 0.1 — revisión independiente con idempotencia duradera

## Problema anterior
La revisión de un parte podía quedar confirmada por PostgreSQL pero perder el ACK HTTP. El frontend incorporó una consulta de reconciliación en PR #279, pero carecía de un UUID de solicitud persistente en el servidor: tras un cierre, doble pestaña, retry o reinicio de la conexión, el POST no podía distinguir una entrega duplicada de una nueva decisión.

## Contrato implementado
- `POST /api/v1/work-orders/:id/executions/:executionId/review` acepta `client_request_id` UUID opcional para conservar compatibilidad legacy. Los nuevos formularios envían UUID aleatorio una vez por decisión.
- Tabla `work_order_execution_review_requests` con PRIMARY KEY (tenant_id, reviewed_by, client_request_id), FKs tenant-scoped, RLS habilitada y **FORCE RLS**; almacena fingerprint SHA-256 de orden+parte+decisión+motivo/checklist y NO almacena blobs, GPS, cookies ni tokens.
- Se toma lock de la orden y del parte; se revalida el rol de coordinador/admin y que revisor != submitter; reserva, decisión y único `work_order.execution_reviewed` se confirman juntos en la transacción por request, o se revierten juntos.
- Primer intento con UUID: **200 `replayed:false`**. Mismo actor/tenant/UUID y payload: **200 `replayed:true`** sin editar parte/auditoría; incluso si después se completó la orden. Mismo UUID con otro reporte o payload: **409 `EXECUTION_REVIEW_REQUEST_CONFLICT`**. Diferente revisor, otro tenant o permiso revocado nunca obtienen recibo ajeno.
- Reintento manual en UI: se mantiene en memoria el UUID y body original cuando no llegó ACK; primero intenta GET autenticado para comprobar; si no confirma, el usuario puede solicitar explícitamente el POST con **exactamente la misma clave y cuerpo**, nunca un reenvío automático.

## QA
- Pruebas puras: fingerprint canónico, choque de identidad, scope y contrato RLS.
- `backend/test/assignmentNotifications.pg.mjs`: real HTTP Express+PostGIS, roles distintos, tenant B, revisión `rejected` + `verified`, replay simultáneo, colisión de UUID, verificación posterior al cierre, auditoría exactamente dos eventos y visibilidad RLS cero para tenant externo.
- Frontend: test de clave UUID, botón consciente de reintento y cuerpo inmutable; el cambio conserva revisión administrativa separada de certificación física.
- Ejecutar: `node --test backend/test/reviewIdempotency.test.js`, suite `backend/test/assignmentNotifications.pg.mjs` con dos URLs `*_test` migradas y rol non-owner, `npm test`, `npm run build`, y CI exact-HEAD PR + CI independiente sobre merge.

## Límites, seguridad y rollback
- El UUID no se persiste en el cliente tras recargar. **Backend sí puede reconocer la misma clave después de una recarga si el cliente la vuelve a presentar**; la recuperación desde UI tras recarga requiere un journal cifrado por actor/tenant en un bloque posterior, sin usar localStorage en claro.
- El endpoint legacy sin UUID se conserva (sigue siendo no idempotente); la UI nueva lo provee.
- No se certifica la ejecución física de la labor: verificación y cierre son administrativos. Vigencia de permisos, RLS y evidencia hash privada siguen en el servidor.
- Down migration **fail-closed** si existe algún recibo: requiere preservar los datos antes de retirar tabla; no ejecutar un down destructivo en producción.
- No staging, VPS, secretos, DNS ni producción; dispositivos Android/iOS y aceptación Product/Security **NO EJECUTADOS**. Release #130 permanece NO-GO. CI de la PR/postmerge se identifica al cerrarse; no suponer PASS.
