# 0U.12 — No reenviar observación aplicada por foto pendiente

## Hallazgo comprobado en código

0U.11 consolidó el ACK completo de imágenes: si llega un recibo incompleto,
la observación aplicada se mantiene en el borrador cifrado como
`syncedObservationId` y la fotografía original continúa sin confirmar.
Sin embargo, el reintento global `offlineQueue.flush` y la opción
`Enviar todos mis pendientes` volvían a invocar `POST /sync/batches`
para ese mismo borrador, aun cuando la observación ya había sido aceptada
por el backend. El envío individual sí impedía el replay del batch y
ofrecía recuperación independiente de foto.

Un replay idempotente del batch no debería duplicar la observación,
pero consume API y puede fallar después de cierre/revocación, confundiendo
el estado de la foto. La ausencia de un recibo de upload de imagen
**no autoriza** repetir observación ni retirar el cifrado local.

## Nuevo contrato

- En una recorrida con foto pendiente, una confirmación de observación
  conserva `syncedObservationId` y el `client_upload_id` inmutable.
- El flush automático o global (`force` incluido) **no llama a
  `submitSyncBatch` ni a `submitOfflineEvidence`** para ese borrador.
- Se comprueba en dos puntos: snapshot de `store.list(scope)` y
  versión actual de `store.get(id)` antes de cualquier HTTP. Evita
  ignorar una transición de otra pestaña entre ambas lecturas.
- Para un borrador `pending` retenido, el resultado agrega la cantidad
  `photoRecoveryRequired`; no se cuenta como envío ni como conflicto.
  Borradores de otras observaciones no bloquean el avance.
- En `SyncPage`, `Enviar todos mis pendientes` informa cuántas fotos
  precisan conciliación y explica el paso siguiente.
- La recuperación se mantiene **únicamente en**
  `OfflineReconciliationPanel`: solicita
  `GET /sync/my-batches` actualizado del mismo actor, comprueba
  el recibo y solo entonces reenvía **los mismos bytes de la foto** al
  endpoint idempotente, sin repetir GPS, observación ni lote.

## Pruebas

`node --test frontend/test/offlineEvidence.test.js`

Verifica foto pendiente tras ACK perdido, retención exacta de datos
en un flush global `force:true`, emisión de otros lotes pendientes,
y relectura cuando otra pestaña modifica el estado entre listado y
envío. La suite focal existente `offline-photo-ack.yml` ya se activa
por el cambio en `offlineQueue.js`; evita agregar un workflow
redundante. La integración full incluye Chromium y PostGIS descartable.

## Límites

- El indicador `syncedObservationId` es evidencia local de un ACK
  previo; para **subir la foto** sigue siendo obligatorio validar
  un recibo fresco, personal, del backend. Ningún auto-upload ocurre.
- No añade desbloqueo de cold-start offline sin sesión (#163), ni
  confirma Android/iOS físicos; QA física y staging = NOT_RUN.
- No modifica contratos backend, auth, RLS ni almacenamiento cifrado.
- No toca servidores, imágenes Docker productivas ni secretos.
- GO/NO-GO para piloto regido por #130: **NO-GO**.
