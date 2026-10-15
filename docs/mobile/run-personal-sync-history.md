# 0S.11 — Historial verificable de sincronización personal por recorrida

## Flujo de campo

En **Monitoreo → Detalle de recorrida → Historial de sincronización** se consultan las operaciones de observación que **el servidor ha confirmado para la cuenta activa** y que tienen `scouting_run_id` en el `SyncOperation.result` coincidente con esa recorrida. Esta vista sólo se monta después de que `GET /scouting/runs/:id` devolvió un detalle autorizado y validado (no demo, no error, no carga).

La pantalla muestra el total de **operaciones aplicadas**, el de **resultados sin verificación completa**, hasta diez filas por página visual (sin ampliar la consulta), fecha recibida/procesada si existe, recibo y observación con identificadores abreviados. Se pueden mostrar más entradas de la respuesta con «Ver más operaciones».

## Fuente y límites de la prueba

Fuente exclusiva: `GET /api/v1/sync/my-batches`, que requiere `sync.submit`, está limitado al actor `submitted_by`, hereda el tenant bajo RLS y devuelve como máximo **100 lotes recientes**. Este historial **no** consulta `GET /sync/batches` de administradores para mezclar operaciones de otros usuarios. Los permisos del frontend son únicamente una segunda barrera, no reemplazan los controles del servidor.

La verificación reaprovecha el parser `parseMySyncReceipts`: validación de sesión/actor, identificadores UUID, estados conocidos, operaciones presentes y límite de respuesta. Una fila se declara **aplicada en PostgreSQL** sólo si simultáneamente:

1. `SyncOperation.result.scouting_run_id` coincide exactamente con la recorrida autorizada.
2. `SyncBatch.status === processed` y `SyncOperation.status === applied`.
3. `entity_type === scouting_observation`, `operation === create`; `operation.id`, `entity_client_id` y `result.observation_id` son UUID válidos.
4. No hay identificadores de operación ni observación duplicados entre las operaciones retornadas para la recorrida.

Las filas cuyo `result.scouting_run_id` está ausente **no se atribuyen** al run ni por `client_id`, `device_id`, `idempotency_key`, payload o fecha. Un lote fallido puede no tener resultado vinculable y no aparecer. Una fila identificable pero inconsistente figura como **sin verificación completa**, nunca como aplicación exitosa.

**Alcance exacto:** este es el historial **de mi cuenta dentro de la ventana de 100 lotes**, no una auditoría completa de la recorrida ni un agregado de todos los operadores. Cero operaciones mostradas significa cero operaciones **atribuibles en la respuesta actual**; no demuestra que nunca existieron. La vista local `RunOfflineCaptures` permanece separada para consultar borradores cifrados del dispositivo. No se suman historiales y borradores como si representaran observaciones distintas.

Un recibo de observación **jamás prueba la carga de una fotografía**. La evidencia tiene confirmación propia en `POST /scouting/observations/:id/evidence` y el mecanismo 0S.6. El historial no presenta un contador de fotografías exitosas ni inferencias de GPS.

## Privacidad, desconexión y estados obsoletos

Se limita al usuario/tenant/rol/entitlements y recorrida vigentes; respuestas HTTP de una sesión/contexto anterior se descartan, y nunca se muestran en otra cuenta antes de una nueva consulta. Ante desconexión, la vista borra el éxito anterior, invalida solicitudes tardías y avisa que **no puede verificar el servidor**. La carga y el error tampoco se muestran como historial vacío confirmado. Hay verificación explícita mediante botón, refresco al reconectar y al volver a mostrar la pestaña.

Solo aparecen IDs abreviados, fases de confirmación y fecha; no se imprimen notas privadas, payloads de operaciones, fotos, nombres de archivos, geocoordenadas ni credenciales. No se agrega almacenamiento, IndexedDB extra ni requests de terceros.

## Verificación

- `frontend/test/runPersonalSyncHistory.test.js`: resultado legítimo, varios runs en un lote, estados parciales, IDs inválidos, diferente actor, 100 lotes, duplicados de observación y privacidad.
- `frontend/test/runSyncHistoryUI.test.js`: montaje detrás de autorización, uso exclusivo de recibos personales, context key reactivo, fallos/offline y sin mutación de la cola.
- Gate estándar: frontend + backend unit, React build, PostgreSQL/PostGIS con RLS y Chromium offline sobre HEAD exacto antes del merge.

## Pendientes del piloto

El histórico completo o entre varios operadores requerirá un endpoint **específico de recorrida**, paginado, autorizado y con pruebas RLS dedicadas; no se simula en esta pantalla. Validar con iPhone/Android físicos la pérdida de conexión, revocaciones, cambios de cuenta, datos anteriores al límite y varias pestañas. El bloque **no** modifica backend, migraciones, GPS, foto ni realiza despliegues.
