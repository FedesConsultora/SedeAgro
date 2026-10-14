# Bloque 0I — Cola offline web para observaciones de campo

## Alcance implementado

Se agrega una cola persistente **en el navegador web**, no una aplicación móvil nativa. El formulario de observación guarda primero un lote local compatible con el contrato del Bloque 0H. La app intenta enviarlo cuando hay conexión, al abrir sesión y al volver a activar la pestaña. Después de un corte, se reenvía **exactamente el mismo cuerpo** con idénticos UUIDs de operación e idempotencia.

El servidor del Bloque 0H sigue siendo la única autoridad: comprueba tenant, rol, asignación, estado de recorrida y campo de campaña en la transacción PostgreSQL. Un borrador local no aparece como una observación real hasta que el servidor confirma `processed` / `applied`.

## Almacenamiento y aislamiento

- Base IndexedDB `sedeagro-offline-sync`, store `pending-observations`, índice `scope` por `tenant_id:user_id`.
- Hasta **100 observaciones locales por usuario/tenant**, una operación por lote con hasta 10000 caracteres de notas y `client_id=sedeagro-web-offline-v1`.
- No se almacenan JWTs en cada entrada. Se requieren sesión real y tenant para guardar, mostrar y enviar; la pantalla solo lista los borradores del usuario y empresa activos.
- Se preservan en el dispositivo los borradores pendientes al cerrar sesión para permitir recuperarlos **solo al volver a iniciar sesión con el mismo usuario y tenant**. Los datos no se cargan al servidor ni se muestran a otras cuentas.
- **Limitación explícita:** IndexedDB almacena borradores de campo **sin cifrar**. Personas con acceso al perfil de navegador/dispositivo pueden inspeccionarlos aunque la interfaz filtre por cuenta. No utilizar en equipos públicos o compartidos; borrar borradores sensibles desde Sincronizaciones. Para dispositivos administrados se requerirá protección del disco/perfil y cifrado específico antes del piloto.

## Entrega, reintentos y conflictos

La cola entrega lotes individuales vía `POST /api/v1/sync/batches` de manera secuencial. `navigator.locks` serializa envíos entre pestañas que lo soportan; sin Web Locks, la idempotencia de PostgreSQL sigue evitando aplicar la misma clave dos veces.

- Tras respuesta con `status=processed`, misma `idempotency_key`, operaciones `applied` y UUID de observación: se elimina la entrada local. También se acepta el replay 200 de una solicitud ya aplicada.
- Ante desconexión, HTTP 408/429/5xx o respuesta ambigua/incompleta: queda **pendiente**, con backoff entre 5 s y 5 min. La interfaz permite reintento manual; el evento `online` puede forzar un nuevo intento.
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

**No hay todavía** cliente React Native/Expo, sincronización del dispositivo móvil a nivel del sistema operativo, Background Sync API, push, cuotas por archivos offline, subida de evidencias offline, reconciliación de updates/deletes ni cifrado de datos en reposo de IndexedDB. Los lotes antiguos `received` tampoco se reprocesan automáticamente.

La cola usa el contrato estricto de observaciones **create-only** del servidor. Las evidencias deben adjuntarse luego de que la observación figure en Monitoreo y el backend la haya confirmado. No desplegar al VPS sin copia consistente de DB y el runbook `docs/security/postgres-rls-runbook.md`. El frontend requiere servir `sw.js` como archivo público.
