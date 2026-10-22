# PILOT-EVIDENCE-SINGLEFLIGHT — adjuntos privados sin duplicación por carrera de UI

## Falla corregida sobre main@902aae3

En las dos pantallas online de observaciones y partes de órdenes, el servidor ya admite `client_upload_id` para confirmar reintentos y los JPEG se recodifican sin EXIF antes del POST. Sin embargo, el helper `createPrivateUploadCache` guardaba el resultado **después** de completar Canvas/FileReader. Dos llamadas solapadas con el mismo archivo e identificador podían producir JPEG distintos y competir por la misma clave. Además, `reset()` no invalidaba el callback de una conversión antigua, que podía repoblar la caché durante otro usuario/observación.

Las UI utilizaban `saving`/`busy` (React state), que no es un cerrojo síncrono: dos `submit` disparados antes de un nuevo render podían ingresar al flujo de upload, aunque el botón pareciera deshabilitado.

## Contrato de corrección

- `createPrivateUploadCache.prepare(file,uuid)` registra un **único Promise** antes de la primera operación asíncrona y lo comparte mientras se está convirtiendo la foto. Cuando termina exitosamente, reintentar después de un ACK perdido reutiliza **exactamente el mismo payload** para esa pareja de archivo/UUID.
- Cambiar de archivo o UUID, o llamar `reset()` al cambiar tenant/usuario/recurso, invalida una generación. Una conversión antigua que finalice después rechaza la operación y **no reestablece el JPEG viejo** ni limpia la nueva entrada de caché.
- Si falló la conversión sin POST, esa generación se descarta para permitir seleccionar o reintentar el archivo. No hay fallback a los bytes originales.
- `EvidenceUploadModal` y `WorkOrderExecutionEvidence` registran **un ticket síncrono** antes de `setSaving/setBusy`. Un segundo submit del mismo contexto activo no hace otro POST. El `finally` de una sesión vieja no puede liberar un ticket nuevo.
- Se mantienen los límites y permisos anteriores: JPEG/PNG/WebP/HEIC/HEIF como orígenes <=12 MiB, JPEG saneado <=512 KiB como salida, PDF <=2 MiB sin modificar, RLS/API/autenticación sin alteraciones.

## Pruebas de CI

`frontend/test/privateEvidenceUpload.test.js` comprueba con promesas diferidas: concurrencia con mismo UUID, conversión única, reutilización de Base64 tras ACK ambiguo, reset durante Canvas, nueva identidad de archivo, cambio de UUID y rechazo/recuperación de un decoder fallido. Las aserciones estáticas comprueban la presencia del guard síncrono y del ticket de identidad en ambas UI; `frontend/test/executionEvidence.test.js` verifica la protección en el parte de orden. Ambos archivos se ejecutan por `npm --workspace frontend test` en el flujo de CI existente.

## Límites

Estas pruebas no afirman la ocurrencia de un incidente real ni sustituyen un ensayo de doble toque en Android/iPhone real con red intermitente. La garantía de idempotencia de backend sigue siendo la autoridad para respuestas perdidas; el frontend debe enviar el mismo archivo/UUID convertido. Para campo: probar doble tap antes del render, pérdida del ACK, cerrar modal a mitad de conversión, cambiar de cuenta y subir otra foto nueva. Debe haber un único adjunto recuperable sin filtración de contenido entre tenants.

**No se cambian backend, contratos, permisos, migraciones, flujo offline de borradores, staging ni Docker.** El problema de reapertura offline sin red #163 y la aprobación de release #130 siguen pendientes; `CI PASS` no implica `GO` ni QA física.
