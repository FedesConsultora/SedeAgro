# 0T.10 — Archivos privados asociados a partes de ejecución

## Alcance y garantías
Las órdenes de trabajo ahora admiten fotografías JPEG/PNG/WebP y PDF adjuntos a **un parte específico**, no solo a la orden completa. Se reutilizan la persistencia privada `evidence_assets` y `evidence_blobs`, el detector de MIME por bytes, la verificación SHA-256, la idempotencia, el límite de 2 MiB y FORCE RLS, sin modificar la lógica de Monitoreo. **Adjuntar contenido no certifica por sí solo que el trabajo agrícola ocurrió.** El flujo de declaración y revisión independiente 0T.9 se mantiene.

## Experiencia de usuario
Al abrir una orden en modo real, el apartado **Archivos de respaldo** consulta los metadatos de todos los partes (una sola petición). Mientras la orden esté en progreso y el parte esté **submitted**, únicamente la cuenta que presentó ese parte puede adjuntar hasta **ocho** archivos. El navegador valida tipo, nombre y tamaño; genera un `client_upload_id` UUID al seleccionar cada archivo y conserva ese mismo identificador si hay corte de conexión para reintentar sin duplicarlo. No existe carga ficticia en modo demo.

Los adjuntos se agrupan visualmente por parte; cualquier usuario que pueda leer esa orden puede solicitar **Comprobar integridad** o **Abrir privado**. La comprobación informa `verified / mismatch / missing / unverifiable / oversize`, sin divulgar digest, bytea, coordenadas ni storage_key. La descarga verifica hash/tamaño **antes** de entregar bytes por HTTPS en JSON privado sin caché, crea un object URL local y lo revoca al cerrarlo o cambiar de identidad/orden. PDFs se descargan, las imágenes se previsualizan. Ninguna URL externa pública contiene archivos.

## API
- `GET /api/v1/work-orders/:id/execution-evidence`: `orders.read`, 200 con hasta 160 metadatos privados, 403 por capability, 404 para una orden ajena/invisible al contratista; no devuelve hash ni bytes.
- `POST /api/v1/work-orders/:id/executions/:executionId/evidence`: `orders.execute`, cuerpo JSON `{kind, mime_type, original_name, client_upload_id, content_base64}`, UUID obligatorio y tipos MIME enumerados. 201 recién creado, 200 replay exacto incluso luego del cierre, 409 si UUID se reutiliza con otros bytes/parte o se agotó límite, 403 si autor diferente, 404 tenant/orden/parte invisible, 422 por formato/bytes falsos o excedidos. `FOR UPDATE` sobre orden serializa con revisión/cierre.
- `GET /api/v1/work-orders/:id/evidence/:evidenceId/integrity`: `orders.read`, verificación explícita 200 con `{id,status}`. Una fila metadata sin bytes => `missing`.
- `GET /api/v1/work-orders/:id/evidence/:evidenceId/content`: `orders.read`, 200 con contenido base64 solo si los bytes siguen íntegros; 404 sin blob, 409 hash/tamaño incorrecto. Siempre `Cache-Control: private, no-store` y `nosniff`.

La autorización combina cookie/JWT válida, membresía actual, tenant y entitlement work_orders, capability y orden visible; un contratista solo puede leer órdenes donde sigue asignado. Ni la ruta de scouting ni sus adjuntos cambian. Auditoría de nuevas cargas guarda IDs, kind y tamaño, nunca notas/resultados privados ni contenido.

## Base de datos y migración
`202610150004_execution_evidence_links.js` agrega `evidence_assets.work_order_execution_id` nullable y un FK compuesto `(tenant_id,work_order_id,work_order_execution_id)` a `work_order_executions`. No permite vincular un parte perteneciente a otra orden o empresa; permite evidencias de Monitoreo y evidencias legacy de orden sin inventar vínculos. Índice parcial por tenant/orden/parte y fecha. Mantiene FORCE RLS sobre las tablas existentes. La FK en cascada permite borrar fixtures/tenant como la jerarquía existente; no hay endpoint para eliminar archivos.

El `down` aborta si hay cualquier vínculo de ejecución: no borra silenciosamente asociaciones reales. Antes de un rollback DB hay que respaldar/exportar y acordar una preservación de datos; revertir código no autoriza destruir archivos.

## Aceptación
- 71 rutas de negocio revisadas con capability explícita (67 anteriores + 4 nuevas).
- Unit: políticas de autor/límites/replay/exclusión de secretos, tipo/tamaño/nombre, confirmación del servidor y descarga controlada.
- PostgreSQL/PostGIS tenant A/B: contratista no autor, otro tenant, scout sin capability, MIME falso, replay idéntico, conflicto de UUID, 8/9 límite, SHA íntegro y alterado, fallo de descarga, FK de parte erróneo, revocación, descarga tras cierre, histórico preservado, backup/restore y FORCE RLS.
- React build, pruebas de seguridad y Chromium browser/offline siguen ejecutándose por CI en HEAD exacto; QA física Safari/iOS/Android/red rural y staging real pendientes.

## Riesgos y próximos pasos
La revisión 0T.9 no exige adjuntos obligatorios: **no confundir existencia de archivos con calidad de evidencia**; en algún próximo bloque se puede configurar por tipo de orden una regla de evidencia mínima, sin hacer que un PDF o foto atestigüe automáticamente ejecución. No incluye ingestión de video/audio, EXIF automático, GPS inferido, proveedor externo, upload offline o reanudación chunked; estas capacidades requerirían análisis adicional de privacidad, red y almacenamiento. El SHA-256 detecta corrupción frente a la metadata persistida, no demuestra fecha/lugar ni autenticidad de escena.
