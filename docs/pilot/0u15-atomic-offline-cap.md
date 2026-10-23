# 0U.15 — Tope de borradores cifrados atómico entre pestañas

## Hallazgo funcional

`offlineQueue.queueObservation` consulta `store.list(scope)` y comprueba
`MAX_PENDING_BATCHES=100` antes de cifrar. Dos pestañas del mismo
actor/empresa pueden ver simultáneamente 99 borradores y guardar una
captura adicional cada una. El preflight solo sirve para explicar el
límite en la interfaz: no puede representar una garantía concurrente.

## Reparación

`indexedDbQueueStore.put` conserva el preflight, pero su **alta sin
`expected`** realiza ahora `index('scope').count(scope)` y
`rows.add(encrypted)` en la **misma transacción readwrite** sobre
`pending-observations`. IndexedDB serializa las transacciones de
escritura que comparten ese object store, incluso entre pestañas.
Cuando el conteo ya es 100, la transacción termina sin agregar nada y
la API informa el mismo error explícito de capacidad.

- Un rechazo no elimina ningún borrador ni declara guardado exitoso.
- El contenido permanece AES-GCM cifrado; la consulta usa únicamente
  el índice externo `scope`, no datos de la foto o notas.
- `add` continúa rechazando colisiones UUID sin sobrescribir un
  registro existente.
- El límite pertenece al par tenant/actor, no al navegador entero.
- `put(item, {expected})` y `delete(id, {expected})` conservan
  su comparación de revisión atómica: permiten actualizar/revisar
  borradores mientras la cola está completa, sin aumentar su tamaño.

## Evidencia automatizada

Se amplió la prueba **real Chromium** `frontend/test/offlineBrowser.mjs`
que ya corre en la matriz general. Dos pestañas comparten IndexedDB:
se crean 99 registros válidos y cifrados en el mismo scope,
ambas escriben simultáneamente el número 100, se verifica 1 éxito y
1 error de límite, se recarga la aplicación, se cuentan exactamente
100 borradores, se modifica uno por CAS y se prueba que una segunda
empresa aún puede guardar. No agrega dependencias ni otro CI.

## Límites de aceptación

No modifica cold-start offline sin autenticación; #163 continúa
pendiente de diseño seguro y de prueba Android/iOS física.
No se envían datos, no se cambia backend, RLS o token. No es
evidencia de QA en dispositivos físicos ni certificación de staging.
Release #130 sigue **NO-GO**.
