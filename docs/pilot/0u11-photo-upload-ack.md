# SedeAgro 0U.11 — ACK completo de fotografía en sincronización offline

## Defecto confirmado por código

Hasta este bloque, el envío automático `offlineQueue.flush` eliminaba una
captura cifrada cuando recibía HTTP 2xx con solo tres campos de imagen:
`client_upload_id`, `scouting_observation_id` y un `size_bytes` definido.
Una respuesta con tamaño incorrecto, `uploaded_by` de otra persona,
`mime_type` distinto o `original_name` ajeno podía descartarla. El
camino manual de recuperación ya verificaba un recibo completo mediante
`verifiedPhotoUpload`, pero ese guard no se reutilizaba en el flujo normal.

## Cambio mínimo y verificable

`frontend/src/services/offlineQueue.js` conserva primero el ACK de
observación, que se guarda con `syncedObservationId` en IndexedDB
cifrado. Antes de borrar el borrador **comprueba el recibo fotográfico**
con el validador existente:

- UUID válido de evidencia devuelto por backend;
- `client_upload_id` estable, igual al de la foto local;
- `scouting_observation_id` exacto;
- `uploaded_by` idéntico al usuario de la sesión;
- `kind`, `mime_type`, `original_name` idénticos al archivo;
- `size_bytes` exactamente igual a los bytes locales validados.

Si el recibo es incorrecto o se pierde el ACK, `flush` no declara
`sent` y conserva el borrador AES-GCM, el UUID de idempotencia y
`syncedObservationId`. La corrección no cambia el API, ni crea
fotografías nuevas, ni relaja roles/tenant, ni altera la política de
backoff. Una repetición HTTP debe devolver la misma evidencia para
poder completar y descartar el borrador. Esto evita **pérdida silenciosa
local**, pero no constituye prueba de que el servidor esté disponible.

## Pruebas y límites

- `node --test frontend/test/offlineEvidence.test.js` exige un recibo
  completo en el caso positivo y rechaza once respuestas con identidad,
  tipo, nombre o tamaño defectuosos sin borrar el borrador.
- Confirma que una repetición posterior idempotente con recibo
  completo sí puede retirarlo, con el mismo UUID.
- CI focal reutiliza Node 22 sin servicios/DB. La batería principal
  debe validar navegador/offline, aislamiento tenant y pruebas de
  backend antes de integrar.
- P1 #163 (reinicio totalmente offline) sigue sin reparación ni test
  físico: no se modifica sesión ni se restaura autorización desde
  IndexedDB. QA real Android/iOS y staging **NOT_RUN**.
- No hay operación sobre VPS, producción, secretos ni datos reales.
  #130 sigue **NO-GO**.
