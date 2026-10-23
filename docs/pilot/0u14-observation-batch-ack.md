# 0U.14 — Recibo de observación completo antes de retirar borrador offline

## Brecha del contrato frontend

En `offlineQueue.flush` el recibo de `POST /sync/batches` se consideraba
suficiente si `status=processed`, `idempotency_key` y
`entity_client_id` coincidían y `observation_id` era alguna cadena.
No comprobaba que el resultado correspondiera a la recorrida enviada.
Una respuesta HTTP 2xx parcial/inconsistente podía borrar un borrador
AES-GCM o fijar `syncedObservationId` con un valor inválido.

El backend ya devuelve, para primera aplicación y replay idempotente,
`data.id`, `data.client_id`, `data.idempotency_key`,
`data.status`, `data.operations[*].entity_client_id`,
`status`, `result.observation_id`, `result.scouting_run_id`,
`result.field_id` y `replayed`.

## Cambio mínimo

`verifiedObservationBatchAck` valida antes de modificar IndexedDB:

1. **Identidad y éxito del batch:** UUID real, cliente exacto,
   clave de idempotencia original, estado processed y indicador
   `replayed` booleano.
2. **Única operación:** identidad `entity_client_id` exacta,
   estado applied y el borrador contiene exclusivamente
   `scouting_observation/create` para la recorrida registrada.
3. **Resultado:** UUID de observación, UUID de lote y
   `scouting_run_id` igual al `runId` local.

La cola usa el UUID verificado para un upload fotográfico posterior
y nunca elimina el borrador por un string falso o por la recorrida
incorrecta. Los errores ambiguos retienen la copia, el estado y
los UUID estables para un reintento idempotente. No se cambia el
endpoint, modelo de datos, permisos, RLS ni cifrado.

El validador comprueba congruencia de la respuesta; **no verifica una
firma criptográfica** ni sustituye la autenticación, la política
tenant del backend o una aceptación física de campo.

## Pruebas y gates

- `frontend/test/offlineBatchAck.test.js`: casos positivos para
  primera carga/replay, 14 recibos malformados/cruzados,
  8 casos de corrupción de borrador y errores incompletos.
- Fixtures de los tests existentes de cola, reintento individual,
  evidencia privada y CAS se ajustan a la respuesta REST real
  documentada en `backend/src/modules/sync/router.js`.
- Se amplía el workflow focal `offline-photo-ack.yml` con
  las pruebas de ACK de observaciones y CAS. CI de integración
  deberá pasar en exact-head, sin saltar Chromium ni PostgreSQL RLS.

## Restricciones de release

MOB-05 cold-start offline (#163) no se repara aquí. Android/iOS físicos
y staging siguen NOT_RUN. El contrato manual de recuperación solo-foto
de 0U.12 permanece intacto, exige recibo personal actualizado.
No VPS, secretos, deploy ni datos productivos. #130: **NO-GO**.
