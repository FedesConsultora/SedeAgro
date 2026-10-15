# 0S.14 — Historial paginado y verificable de evidencias por recorrida

## Objetivo y uso

**Monitoreo → Detalle de recorrida → Verificación de fotografías y archivos** ahora obtiene **10 evidencias por página** y permite ir a **Archivos anteriores** o **Página anterior**, evitando que los archivos antiguos queden inaccesibles tras los primeros 100 de la implementación 0S.12. Los archivos se muestran únicamente como metadatos privados sin notas, coordenadas, nombres ni bytes. La comprobación SHA-256 del bloque 0S.13 sigue siendo **manual, individual y exclusivamente para los diez archivos visibles**; los resultados transitorios se reinician en cada cambio de página/recorrida/cuenta.

**No se usa offset**, conteo total, búsqueda ilimitada ni descarga de blobs. En lugar de ello se utiliza un cursor de ordenamiento estable por `(created_at DESC, id DESC)`, incluso cuando múltiples archivos tienen la misma fecha.

## Contrato compatible con la API existente

`GET /api/v1/scouting/runs/:id/evidence-status`

- Sin parámetros: **comportamiento anterior** (`limit=100`) + `next_cursor`.
- Con `?limit=10`: primera página de diez.
- Con `?limit=10&cursor=<token>`: siguiente página hacia archivos antiguos.
- `limit`: entero decimal sin cero inicial entre 1 y 100. No se permite `offset`, claves desconocidas, arrays ni tamaños arbitrarios; HTTP 400.
- Respuesta: `data: { run_id, limit, has_more, next_cursor, items }`; `next_cursor` es string opaco y firmado si existe otra página, `null` al finalizar. Un page cursor sólo se emite para el último registro visible si sobró al menos un registro del mismo tenant y recorrida.

El cursor contiene versión, fecha, ID de la última evidencia, tenant, recorrida y límite, firmado con HMAC SHA-256 usando un secreto del servidor. El backend verifica integridad criptográfica del cursor y coincidencia exacta con los parámetros de la consulta. Cambiar un byte, reutilizarlo para otra empresa/recorrida/tamaño de página o enviarlo incompleto falla en HTTP 400. No otorga permisos: cada página vuelve a validar sesión activa, entitlement `scouting`, `scouting.read`, asignación de recorrida del operador mediante `findRun` y RLS de PostgreSQL. La firma no reemplaza la autorización. `Cache-Control: private, no-store`.

Se conservan los controles de integridad y privacidad previos: `EvidenceAsset.findAll` selecciona exclusivamente IDs, metadatos mínimos y `created_at` para construir el cursor; `EvidenceBlob.findAll` selecciona únicamente `evidence_id` para saber si hay bytes, no `content`. Hash, nombre y ubicación de almacenamiento permanecen excluidos de la respuesta.

## UI y fuente local

- Paginación hacia atrás mediante pila local de cursores; volver a la página anterior usa su cursor anterior, no índices offset. Los resultados no se mezclan entre páginas.
- Actualizar desde el botón **Verificar de nuevo** vuelve al inicio para evitar mostrar una cronología antigua como reciente.
- Si cambia cuenta, tenant, rol, módulo, recorrida, conexión o estado de la cola, se revalida la consulta y se descartan respuestas asincrónicas obsoletas. El control de integridad se desmonta cuando cambia `pageKey`.
- **Una foto local no encontrada en esta página tiene estado incierto**, incluso si esta es la última página: no se convierte en «no subida», error definitivo ni permiso para descartar una copia cifrada. La lista local se correlaciona por `client_upload_id`, actor, tipo, tamaño y observación si existe; solo los registros de esta página pueden coincidir.
- Se distinguen contadores **de la página**, no de toda la recorrida. No se comunica un total global desconocido.
- No se modifican `offlineQueue`, cifrado, IndexedDB, sincronización, evidencias ni operaciones de carga.

## Pruebas y límites

- Unitarias backend: token firmado, alteración, binding a tenant/run/limit, vencimiento por cambio de secreto, límites de consulta y fechas inválidas.
- PostgreSQL/PostGIS/RLS: dos evidencias con misma fecha; resultado determinista por ID descendente, páginas de tamaño 1, fin de historial, rechazo de cursor de otro run, de otro límite, manipulado, de otro tenant y scout no asignado.
- Frontend: validación de `next_cursor`, cambio de página, privacidad, no inferencia de fallo por ausencia, SHA-256 visible solamente para la página actual.
- Gates de CI: Node/frontend tests, React build, PostgreSQL/PostGIS/RLS y Chromium real en HEAD exacto antes de merge.

Una paginación por keyset no equivale a una instantánea transaccional de **todas** las páginas: las páginas consultadas en momentos distintos podrían reflejar modificaciones o nuevas subidas. No se promete un recuento histórico perfecto. No hay migraciones ni cambios de RLS/schema/roles. Sigue pendiente prueba física en iOS/Android, redes móviles rurales, carga real con miles de evidencias y un índice dedicado si el volumen lo exige. Sin despliegue.
