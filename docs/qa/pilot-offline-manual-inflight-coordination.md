# SedeAgro 0.1 · Envío manual que se solapa con sincronización automática

**Fecha:** 2026-11-03. **Base:** `main@5b3453daad77131adfbc24000142deaef4e52a8b`. Continuación de los gates de GPS/foto offline y los reintentos cifrados.

## Falla de producto

En la misma pestaña, `SessionContext` puede iniciar un `offlineQueue.flush()` automático al reconectarse, revalidar sesión o cargar la cola. El operador, al abrir **Sincronizaciones** y pulsar **Enviar pendientes** o **Enviar solo esta**, recibía inmediatamente `skipped:true` si `inFlightScopes` ya estaba ocupado. La UI lo describía como si necesariamente fuera otra pestaña. La orden manual quedaba perdida aunque el envío automático hubiese fallado después de perder el ACK o antes de subir la foto. El backend es idempotente, pero esto impedía al usuario confirmar un reintento oportuno.

## Contrato nuevo

1. La ruta automática continúa no bloqueante y sin acumulación de trabajo. Solo `flush(...,{waitForBusy:true})` y `flushOne()` (gestos manuales) pueden unirse al vuelo **del mismo tenant y actor**. No se mezclan otras empresas.
2. Si existe un envío local activo, la petición manual aguarda hasta **12 segundos como máximo** a que finalice, sin abrir HTTP simultáneo. Tras concluir vuelve a leer el borrador **desde IndexedDB cifrado**, dentro del bloqueo de la cuenta. Si el automático lo confirmó y borró, la ruta manual NO repite el batch ni la fotografía. Si perdió el ACK, la ruta manual puede retomar el **mismo body e idempotency_key**: solo el servidor define si hay un replay, y un recibo incompleto no retira datos.
3. Si la observación ya tiene `syncedObservationId` y quedó solo su fotografía pendiente, el reintento manual individual devuelve `photoRecoveryRequired`, conservando la foto en el dispositivo para la conciliación independiente. Nunca repostea el batch en ese caso.
4. Si el otro vuelo pertenece a **otra pestaña**, el gesto manual espera hasta 12 segundos la adquisición del Web Lock `sedeagro:sync:<scope>`, cuando el navegador soporta `navigator.locks`; el envío automático conserva `ifAvailable:true`. El plazo se cancela **al adquirir el lock**, no se aplica a una subida HTTP ya iniciada. Si el lock no queda libre a tiempo, se devuelve `skipped` sin afirmar éxito ni tocar ciphertext.
5. `SyncPage` solo comunica un resultado si el scope de sesión sigue siendo el que inició la acción. El mensaje `skipped` deja de decir sin pruebas «otra pestaña»; informa que no existe confirmación y exige actualizar/comprobar antes de reintentar. No se admiten afirmaciones de foto subida basadas solo en el ACK del batch.
6. Sin Web Locks, el navegador mantiene el fallback existente: lectura fresh + CAS cifrado, validación de recibos exactos e idempotencia backend. No se puede garantizar serialización total sin soporte Web Locks; no se degrada la seguridad tenant/RLS.

## Aceptación

- `frontend/test/offlineQueue.test.js`: lote automático exitoso con gesto manual concurrente → **exactamente un POST** y cero filas pendientes; ACK de COMMIT perdido → reenvío manual con **UUID y cuerpo idénticos**, una sola observación lógica en el servidor simulado; otro tenant continúa independientemente; las rutas automáticas no esperan; tercera opción del lock solo para manual.
- `frontend/test/offlineQueueSingle.test.js`: envío individual concurrente espera y descubre fila ya consumida; foto con observación aplicada pero ACK de evidencia perdido exige **recuperación de foto únicamente**, sin repetir lote y conservando bytes/UUID.
- `scripts/acceptance-browser-cookie.mjs`: conserva la secuencia completa real React+Chromium+Express+PostGIS: captura GPS/foto opt-in, AES-GCM en IndexedDB, cierre/reapertura del SPA, pérdida controlada de respuesta, reanudación con **como máximo un clic manual** y comprobación de HTTP real, única observación PostGIS y foto privada intacta. No se fabrica ningún 2xx ni se deshabilita el envío automático.
- Gate obligatorio previo a merge: CI **exact-head** (5/5), luego ejecución independiente `main` (7/7). Cualquier PASS se documentará solo una vez visto el resultado real.

## Riesgos y rollback

- El join puede consumir hasta 12 segundos cuando otra operación usa el mismo scope. El timeout no indica fallo de servidor y **no autoriza** a descartar ni regenerar IDs. Se prioriza preservar el ciphertext y una señal honesta frente a un falso envío.
- La nueva espera no sustituye permisos, cookie HttpOnly, autorización backend ni FORCE tenant RLS; tampoco cambia cómo se cifra IndexedDB o cómo se solicita `navigator.storage.persist()`.
- Para rollback se puede revertir el frontend sin migraciones ni limpieza de datos; los borradores existentes y los recibos idempotentes continúan compatibles.
- Sin backend/migraciones/workflows/VPS/producción/staging. No se han probado Android/iOS reales ni el proceso completo de campo: **release #130 continúa NO-GO**.
