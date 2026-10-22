# PILOT-OFF-DOUBLE-SAVE — Una captura, un guardado local ante doble toque

## Falla corregida

La pantalla `ObservationFormModal` capturaba eventos `submit` y asignaba `setSaving(true)`, pero el valor `saving` sólo bloqueaba el botón después de un nuevo render React. Con doble toque rápido, teclado + botón o eventos cercanos mientras Canvas convierte JPEG, podían lanzarse **dos** `offlineQueue.queueObservation` para una sola selección. Esa cola crea un `idempotencyKey` distinto por invocación; cada entrada persistida en IndexedDB cifrado constituye una observación diferente para el backend. La idempotencia de sincronización no sirve para deduplicar dos entradas **distintas**.

## Contrato corregido

- `createMobileCaptureSubmitGate()` adquiere un ticket **sincrónicamente**, antes de cualquier await o setState. Una segunda entrega en la misma generación no entra en conversión JPEG ni escribe en IndexedDB.
- El ticket corresponde al `createMobileCaptureFence` vigente; un `reset()` por cierre de modal/cambio tenant+usuario/recorrida invalida el ticket viejo. `settle(ticket)` del callback anterior no suelta el del nuevo formulario.
- Si `offlineQueue.queueObservation` rechaza sin haber confirmado escritura, el gate libera el intento y permite reintentar con la misma selección. Los errores existentes siguen visibles.
- Si la escritura devuelve éxito, el gate queda tomado hasta el **cierre/reinicio del formulario**, incluso si `onQueued` cambia la pantalla de forma asíncrona. Así no se puede guardar dos veces pulsando antes del siguiente render.
- Si la notificación `onQueued` falla después de la persistencia exitosa, se informa que la captura **ya está guardada** y se indica revisar Sincronizaciones; no se comunica engañosamente “no se pudo guardar”.
- No se alteran los UUID, `client_id`, reintentos HTTP, cifrado AES-GCM, esquema IndexedDB, fotos JPEG sanitizadas ni GPS opcional.

## Pruebas y QA real

`frontend/test/mobileCaptureSafety.test.js` incluye adquisiciones sincrónicas repetidas, ejecución de dos submit con una promesa IndexedDB diferida, éxito que permanece bloqueado, rechazo que permite reintento, cierre/reset, cambio de sesión y finalización vieja sin efecto sobre un ticket nuevo. Verifica el cableado del modal antes de `offlineQueue.queueObservation` y que no se libera el guard al guardar correctamente.

En Android Chrome e iOS Safari físicos: iniciar una recorrida autorizada, seleccionar foto grande y presionar **Guardar observación** dos veces rápidamente; observar en Sincronizaciones y IndexedDB sólo un borrador, un mismo par de cliente/operación y una única observación servidor tras conexión. Repetir con teclado y botón, navegador lento, error de Canvas, almacenamiento lleno, cambio de usuario/empresa y cierre durante compresión.

**Límite importante:** el gate previene duplicados dentro de **una instancia del formulario**. No es un candado transaccional entre pestañas, ni resuelve un `IndexedDB.put` que hubiera confirmado en disco y después arrojara un error ambiguo. No sustituye las pruebas de aceptación con dispositivo real ni el manejo criptográfico de cold-start #163. Es un bloqueo de una carrera demostrable por el flujo fuente, no un incidente de campo observado. #130 continúa NO-GO.

No se modificaron backend, RLS, work orders, esquema de cola offline, permisos, CI ni infraestructura.
