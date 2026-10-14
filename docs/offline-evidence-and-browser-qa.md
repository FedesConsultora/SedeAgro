# Bloque 0K — Fotografías offline con confirmación de dos etapas y pruebas en Chromium

## Flujo de campo

El formulario de nueva observación admite **una foto opcional** JPEG/PNG/WebP de hasta **512 KiB**. Se comprueba el nombre, tipo, tamaño y firma inicial. Se genera un UUID de carga estable `client_upload_id` y se almacena junto con el borrador en la misma entrada cifrada AES-256-GCM de IndexedDB v2 (clave por tenant+usuario). **No se incluye el contenido de imagen en `POST /sync/batches`**, cuyo contrato sigue siendo observaciones create-only.

Al reconectar, la cola de sincronización:
1. Envía el mismo lote de observación idempotente del Bloque 0H, conservando `idempotency_key` y `entity_client_id`.
2. Comprueba la confirmación de `status=processed` y el `observation_id` resultante; escribe `syncedObservationId` en el registro cifrado.
3. Envía la foto a `POST /api/v1/scouting/observations/:observationId/evidence`, con `client_upload_id`, MIME/nombre y bytes base64.
4. **Solo elimina el borrador tras las dos confirmaciones válidas.** En una desconexión tras aplicar la observación o la foto, la cola reintenta con los mismos UUID y recibe el mismo resultado sin duplicaciones.

Si la observación fue confirmada pero la foto es rechazada (por ejemplo, porque la recorrida cerró antes del upload), el borrador sigue cifrado en estado **Requiere revisión**, mostrando que la observación está aplicada y la foto pendiente. El usuario puede volver a intentar o eliminarlo manualmente; eliminar un borrador no borra datos ya aplicados en el servidor.

## API y migración

Migración `202610140005_evidence_upload_idempotency.js`: agrega `client_upload_id uuid` y `content_sha256 varchar(64)` a `evidence_assets`, más índice único parcial `(tenant_id, uploaded_by, client_upload_id)`. Las evidencias históricas mantienen valores nulos.

El endpoint acepta opcionalmente `client_upload_id`, pero valida el contenido real y calcula SHA-256 en el servidor. Para cargas con UUID estable:

- **Nueva carga:** HTTP 201, guarda metadatos/bytes privados y auditoría en la misma transacción con RLS.
- **Misma clave, mismo actor, observación y contenido:** HTTP 200 `replayed:true`, devuelve ID original y **no duplica** bytes/eventos. Incluso si la recorrida se cerró después del primer upload, el retry de la operación ya aplicada permanece disponible mientras el usuario conserve acceso de lectura a la recorrida.
- **Clave reutilizada con otros bytes/observación/MIME/nombre:** HTTP 409 `EVIDENCE_UPLOAD_CONFLICT`.
- **Otro usuario o tenant:** su contexto se sigue validando con JWT, miembro activo, `scouting.evidence`, RLS y acceso actual a la recorrida. No se concede acceso global por poseer un `client_upload_id`.

Los uploads online tradicionales, sin UUID, siguen admitidos y conservan la semántica previa. El servidor permite hasta 2 MiB, pero la cola offline limita fotos a 512 KiB por cuotas y memoria del navegador. **No hay videos ni PDF offline**; los PDF se siguen cargando online.

## Verificaciones

- Test unitario frontend: foto validada y cifrada dentro del borrador; ninguna imagen sale en el JSON de lote de observación; confirmación primero observación y luego foto; pérdida de ACK/replay con UUID estable; conflictos parciales y respuestas incompletas.
- PostgreSQL/PostGIS: alta con UUID, replay 200 sin duplicar, conflicto 409 por cambio de archivo, rechazo multiusuario/multitenant y replay tras cerrar la recorrida, manteniendo rechazo de nuevas fotos.
- **Nuevo job Chromium**: crea IndexedDB v1 real, accede con el cliente v2, verifica que foto y notas queden cifradas, recarga la pestaña y recupera el contenido; además arranca el build de producción y verifica que el service worker permita reabrir el shell sin conectividad.
- Continúan los gates de backend, frontend, build, migraciones PostGIS y pruebas RLS previos.

## Límites y siguiente paso

El test automatizado de Chromium es un navegador Linux en CI, **no certifica dispositivos Android/iOS físicos** ni condiciones adversas de campo. Se requieren pruebas manuales en dispositivo, cambio de cuenta, cuotas reales, desconexiones prolongadas, permisos de cámara y CSP/XSS hardening. La clave local de cifrado permanece en IndexedDB del mismo origen: esta solución no protege frente a scripts ejecutados allí o a un perfil comprometido. Un cambio de dispositivo o limpieza del almacenamiento puede perder borradores no enviados.

No se implementan aún archivos offline superiores a 512 KiB, edición/borrado de operaciones, galería multimedia, compresión en dispositivo, S3/MinIO ni clientes nativos. Este PR **no despliega al VPS** ni modifica producción; seguir el runbook PostgreSQL antes de migrar la base.
