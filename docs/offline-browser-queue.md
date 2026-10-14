# Bloque 0I — Cola offline web para observaciones de campo

## Alcance implementado

Se agrega una cola persistente **en el navegador web**, no una aplicación móvil nativa. El formulario de observación guarda primero un lote local compatible con el contrato del Bloque 0H. La app intenta enviarlo cuando hay conexión, al abrir sesión y al volver a activar la pestaña. Después de un corte, se reenvía **exactamente el mismo cuerpo** con idénticos UUIDs de operación e idempotencia.

El servidor del Bloque 0H sigue siendo la única autoridad: comprueba tenant, rol, asignación, estado de recorrida y campo de campaña en la transacción PostgreSQL. Un borrador local no aparece como una observación real hasta que el servidor confirma `processed` / `applied`.

## Almacenamiento y aislamiento

- Base IndexedDB `sedeagro-offline-sync`, store `pending-observations`, índice `scope` por `tenant_id:user_id`.
- Hasta **100 observaciones locales por usuario/tenant**, una operación por lote con hasta 10000 caracteres de notas y `client_id=sedeagro-web-offline-v1`.
- No se almacenan JWTs en cada entrada. Se requieren sesión real y tenant para guardar, mostrar y enviar; la pantalla solo lista los borradores del usuario y empresa activos.
- Se preservan en el dispositivo los borradores pendientes al cerrar sesión para permitir recuperarlos **solo al volver a iniciar sesión con el mismo usuario y tenant**. Los datos no se cargan al servidor ni se muestran a otras cuentas.
- **Bloque 0J:** los borradores nuevos se almacenan cifrados con AES-256-GCM, nonce aleatorio de 96 bits y AAD ligado a usuario/tenant e identificador. Las claves son CryptoKey no exportables por scope, persistidas en el almacén IndexedDB `draft-keys` (schema v2). **No es cifrado extremo a extremo**: cualquier script capaz de ejecutarse en el mismo origen puede solicitar a Web Crypto descifrar los registros. Se necesita un dispositivo confiable y CSP/XSS hardening antes del piloto. Una copia del perfil de navegador podría contener tanto el registro cifrado como la clave utilizable.

## Entrega, reintentos y conflictos

La cola entrega lotes individuales vía `POST /api/v1/sync/batches` de manera secuencial. `navigator.locks` serializa envíos entre pestañas que lo soportan; sin Web Locks, la idempotencia de PostgreSQL sigue evitando aplicar la misma clave dos veces.

- Tras respuesta con `status=processed`, misma `idempotency_key`, operaciones `applied` y UUID de observación: se elimina la entrada local. También se acepta el replay 200 de una solicitud ya aplicada.
- Ante desconexión, HTTP 408/429/5xx o respuesta ambigua/incompleta: queda **pendiente**, con backoff entre 5 s y 5 min. El Bloque 0J agrega temporizador de reintento mientras la pestaña esté abierta; la interfaz permite reintento manual y `online` puede forzar un nuevo intento.
- HTTP 400/403/404/409/422: queda **para revisar**, sin reintentos automáticos. Esto incluye recorridas cerradas o reasignadas. El usuario puede solicitar reintento después de corregir permisos o descartar explícitamente.
- HTTP 401: estado de autorización pendiente de intervención, sin descartar ni modificar el lote. El usuario debe reingresar y solicitar reintento.
- El backend puede haber aplicado una escritura antes de perderse la respuesta. Por eso la cola **nunca cambia los UUIDs ni el payload** al reintentar. No se ofrece editar lotes conflictivos en este MVP.
- Si el usuario elimina un borrador mientras una petición está en vuelo, el proceso no vuelve a crear ese borrador después de un fallo. La eliminación no cancela necesariamente una escritura ya confirmada en el servidor; hay que consultar el recibo.

## Experiencia de usuario

- El formulario **Agregar observación** indica que guardar localmente no significa que el backend la haya registrado. Muestra una confirmación distinta cuando se conserva en cola.
- El módulo **Sincronizaciones**, ahora accesible al rol `scout`, presenta por separado borradores locales y recibos del servidor, estado de conectividad, número de conflictos, causa de último error, reintento y eliminación con confirmación.
- `SessionProvider` envía al iniciar sesión, reconectar y reactivar la pestaña. La API de sync no fuerza una recarga automática al recibir 401: la cola conserva el error.
- Se estabilizó la referencia del cliente API frente a cambios del loader/toast global, evitando cancelar solicitudes por renders.
- `frontend/public/sw.js` puede conservar **solo el shell HTML y recursos públicos de `/assets/`** para volver a abrir la interfaz offline tras una primera instalación con conexión. Se registra únicamente en HTTPS/localhost durante builds de producción. No almacena respuestas API, archivos privados, tokens ni datos de campo. La instalación y disponibilidad dependen de las políticas de cada navegador; siempre verificar en un equipo real.

## Verificación

```bash
npm --workspace frontend run test
npm --workspace frontend run build
npm run validate
```

Los tests Node aislados del motor cubren el alcance tenant/usuario, entradas inválidas, cortes de red, pérdida de respuesta después de commit, backoff, conflicto/reintento, una única solicitud activa, confirmaciones ambiguas y eliminación durante el envío. El workflow de GitHub mantiene además PostgreSQL/PostGIS y las pruebas de idempotencia del Bloque 0H.

## Límites no implementados

**No hay todavía** cliente React Native/Expo, sincronización del dispositivo móvil a nivel del sistema operativo, Background Sync API, push, cuotas por archivos offline, subida de evidencias offline ni reconciliación de updates/deletes. El cifrado local no ofrece protección frente a XSS u origen comprometido. Los lotes antiguos `received` tampoco se reprocesan automáticamente.

### Migración y recuperación tras cierres inesperados (0J)

La base se actualiza de IndexedDB v1 a **v2** preservando las filas antiguas. En la primera lectura de los borradores de un usuario/tenant, cada registro en claro se cifra y se reemplaza en una transacción IndexedDB, con comparación para no pisar escrituras o eliminaciones simultáneas. Si falla el cifrado o la migración, se muestra error y no se elimina ni envía el borrador. Los registros de cuentas no abiertas pueden permanecer en claro hasta que ese usuario regrese; **no hay garantía de migración global instantánea**.

Los nuevos guardados se consideran completos solo cuando se confirma la transacción local. Si se pierde la clave CryptoKey pero permanecen bytes cifrados, el cliente falla de forma cerrada y **no genera una clave de reemplazo para borrar silenciosamente los datos existentes**. Borrar datos del navegador puede eliminar tanto la clave como las observaciones y no existe recuperación de una clave eliminada. Guardar los datos cifrados no garantiza retención: cada navegador administra la cuota y puede borrar datos bajo presión de espacio. En Sincronizaciones se muestra la capacidad estimada y un botón explícito para pedir `navigator.storage.persist()`; el navegador puede negarlo. También se comprueba un margen de espacio antes de nuevas escrituras y se capturan errores de cuota. La recuperación ante fallas abruptas depende de la atomicidad de IndexedDB y debe validarse en un navegador real antes del piloto.

La cola usa el contrato estricto de observaciones **create-only** del servidor. Las evidencias deben adjuntarse luego de que la observación figure en Monitoreo y el backend la haya confirmado. No desplegar al VPS sin copia consistente de DB y el runbook `docs/security/postgres-rls-runbook.md`. El frontend requiere servir `sw.js` como archivo público.
