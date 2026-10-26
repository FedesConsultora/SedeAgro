# Piloto SedeAgro 0.1 — Órdenes: recuperación cifrada tras pérdida del acuse

**Issue #204 | Coordinación #18 | release #130 NO-GO**

## Defecto productivo que cierra

El backend ya implementa idempotencia transaccional por `(tenant_id, requested_by, client_request_id)` bajo FORCE RLS en `work_order_create_requests`. El frontend ya admitía reintentar el mismo envío mientras permaneciera abierta la ventana. **Sin embargo, un cierre o recarga del navegador borraba de memoria la clave y el contenido**; un segundo alta podía duplicar la orden.

## Comportamiento implementado

- Sólo para autenticación **live** vigente de admin/coordinador con entitlement `work_orders`. Mock mantiene su creación simulada, sin escribir en IndexedDB ni contactar el servidor.
- Se cifra la UUID original y el cuerpo completo de la orden *antes* del POST con AES-256-GCM, IV aleatorio, CryptoKey no exportable y AAD vinculado a ámbito+UUID, en `sedeagro-work-order-recovery`. Sin tokens, JWT ni cookies persistidos.
- La operación cifrada se guarda con `IndexedDB.add` (no overwrite). Si la cuota del navegador falla o dos pestañas envían simultáneamente, no se transmite el nuevo POST sin haber confirmado primero una escritura local segura.
- Después de cerrar y reabrir el navegador, sólo una sesión revalidada del mismo actor/tenant/rol puede abrir el formulario y ver la recuperación. Se repone título, lote, instrucciones, tipo, prioridad y horario local de la misma fecha UTC. **Reintentar** reutiliza el UUID y el instante ISO previamente sellados, sin reinterpretarlos.
- No hay HTTP de fondo, ni en carga ni al recuperar. Una respuesta incierta deja el envío cifrado intacto. Sólo una confirmación exacta del servidor —mismo UUID lógico, empresa, solicitante, lote, contenido y `replayed` boolean— permite retirar el slot mediante compare-and-delete por UUID y anunciar alta.
- **Descartar tras revisar Órdenes** exige confirmación explícita; el servidor puede haber persistido el recurso incluso cuando se perdió el ACK. La eliminación no puede borrar la solicitud más nueva de otra pestaña.
- El módulo anterior de Campañas, la recuperación de Recorridas y las observaciones+fotografías permanecen separados en IndexedDB y dominios AAD; no hay migración ni cambio de formato.

## Pruebas

`frontend/test/workOrderRecoveryStore.test.js`: validación previa de UUID/lote/tipo/prioridad/horario; separación de almacenes y dominios; preservación antes de POST; render-fence tenant+API; operación manual y no automática; compatibilidad demo.

`frontend/test/offlineBrowser.mjs`: Chromium real, CryptoKey e IndexedDB; bytes cifrados sin título ni instrucciones en texto plano, restauración tras reload, segundo tenant sin acceso, aislamiento respecto de Campañas/Recorridas, CAS por UUID, intento concurrente en dos pestañas y un único slot válido.

El backend previamente cubrió con PostGIS nonowner/HTTP replay mismo-key, concurrencia, conflictos de payload, cuenta revocada y tombstone.

## Límites de aceptación

Este journal es local a un dispositivo/origen y **no habilita login sin conectividad** (#163). Cifrado local no es cifrado extremo a extremo contra scripts con acceso al mismo origen. Staging autorizado, Android Chrome y Safari iOS físicos `NOT_RUN`; producción, deploy y release #130 **NO_GO**. Antes de abrir una nueva orden desde un dispositivo diferente, inspeccionar órdenes del servidor.
