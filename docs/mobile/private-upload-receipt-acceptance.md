# PILOT-EV-ACK — Confirmación verificable de evidencias privadas online

## Problema reproducido en el código

Antes de este bloque, `EvidenceUploadModal.jsx` consideraba exitoso cualquier `await api.createEvidence(...)` que no arrojase excepción: borraba la selección, la caché de JPEG sanitizado y el `client_upload_id`, aunque la respuesta pudiera no tener `data` o pertenecer a otra observación. En órdenes de trabajo, `validateExecutionEvidenceResponse` ya comprobaba `id`, parte y MIME, pero no corroboraba autor, nombre o tamaño de los bytes efectivamente preparados.

Esto **no demuestra una pérdida de archivos observada en producción**; demuestra que el código interpretaba como confirmación respuestas ambiguas. En una zona rural con conexión inestable esa distinción importa porque el mismo UUID debe conservarse tras un ACK no verificable.

## Contrato ajustado, sin cambiar el servidor

**Observación / scouting**: sólo se limpia el formulario cuando el backend devuelve un acuse con `data.id` UUID, `scouting_observation_id` exacto, `uploaded_by` del usuario activo, `client_upload_id` de la selección, `kind`, `mime_type`, `original_name`, `size_bytes` coincidente con el Base64 preparado y `replayed` booleano. Se aceptan tanto HTTP 201 nuevo como HTTP 200 replay auténtico. Con respuesta incompleta o cruzada, se muestra error y **no se resetea** el UUID ni el payload ya recodificado.

**Parte de orden / ejecución**: se extiende el validador existente, sin romper llamadas anteriores, para exigir autor, parte, clase, MIME, nombre y tamaño, además del booleano `replayed`. El endpoint de órdenes usa `visibleExecutionEvidence` y **omite intencionalmente `client_upload_id` y `content_sha256`**; el cliente no inventa esas propiedades ni asegura haber comprobado el digest. El backend sigue siendo responsable de evitar adjuntos duplicados por UUID y hash.

**Cómputo local**: la longitud se obtiene de Base64 canónico acotado a 2 MiB, sin materializar una segunda copia de bytes sensibles. Se rechazan respuestas y payloads malformados antes de comunicar éxito. No se agrega almacenamiento persistente nuevo, ni se modifican límites para JPEG/PNG/WebP/HEIC/HEIF/PDF, sesión, cookies, cifrado offline o permisos.

## Cobertura y límites de aceptación

Tests Node para cada campo cruzado, tipos y tamaños no válidos, `replayed:false` y `replayed:true`, ACK incompleto, y conservación de la misma selección y bytes del JPEG luego de un ACK ambiguo. Los dos componentes deben invocar sus validadores antes de `uploadCache.current.reset()`.

Pendientes de campo: en staging privado autorizado, subir fotografía real desde Android e iPhone; provocar ACK perdido tras commit servidor, reintentar el **mismo UUID**, comprobar **una sola fila y blob** en DB por tenant y que la interfaz muestre confirmación solamente si coinciden los metadatos. Probar orden ajena, cambio de cuenta y cierre a mitad de vuelo. Los tests unitarios no certifican estas pruebas físicas.

Quedan fuera de alcance #163 (reapertura offline sin red), #143 (performance staging) y #130 (aprobación de release). **NO-GO** hasta que las responsabilidades de seguridad, operaciones y aceptación sean firmadas. No se modificó backend, migraciones, Docker ni CI.
