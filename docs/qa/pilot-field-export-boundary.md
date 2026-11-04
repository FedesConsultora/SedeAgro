# 0R.9 — Integridad del archivo descargado por lote

**Base:** main@f507814ccdfe0342c5ab8ad21b81f480cf5163ab · Coordinación #18 · Release #130: NO-GO.

## Defecto de producto confirmado por lectura de código

Los exportadores del backend delimitan un máximo de 200 observaciones, 200 órdenes y 200 ejecuciones por período; el recibo devuelve `filename`, `mimeType` y los tres conteos. Antes de este bloque el navegador solo limitaba de 0 a 200 el contador `executions`, pero aceptaba `observations:-1` o `workOrders:201` como cifras de una descarga válida. Además, el navegador no verificaba que el nombre de archivo declarado por el servidor correspondiera al `fieldId` solicitado, incluso al seleccionar otro lote.

Esto no demuestra una fuga de datos en el servidor: el endpoint tiene autorización y tenant RLS. Sí faltaba defensa del último paso de la UI frente a una respuesta HTTP incoherente o redirigida por error.

## Contrato nuevo

- CSV/PDF/XLSX se validan **antes** de crear una URL `blob:` o entregar el archivo. Su `filename` debe coincidir exactamente con `reporte-lote-<field UUID>.<formato>`; nunca se usa el nombre devuelto para definir rutas de descarga.
- Los tres conteos son **exactamente** `observations`, `workOrders` y `executions`, cada uno entero seguro en el intervalo 0..200. No se aceptan campos extra, negativos, cadenas, decimales, infinito ni una categoría truncada presentada como completa.
- CSV conserva BOM UTF-8, MIME explícito, no admite documento vacío y exige máximo 1 MiB de **bytes UTF-8**, no sólo caracteres UTF-16. PDF/XLSX conservan sus verificaciones existentes de MIME, tamaño, base64 y firma inicial.
- El control se centraliza en `frontend/src/services/reportDownload.js`; `FieldReportCard` lo utiliza con el ID del lote de la vista autenticada. Se mantienen la barrera de contexto actor/tenant/rol/API y la invalidación de operaciones en vuelo.
- Pruebas Node adversariales cubren nombres de otro lote, rutas manipuladas, cada contador inválido, bytes CSV excedidos por Unicode y compatibilidad de PDF/XLSX válidos.

## Fuera de alcance

No se modifica el backend, sus permisos, RLS, los snapshots, los archivos generados, el worker, migraciones, Docker, CI ni deployment. Este control de cliente **no sustituye** el aislamiento del servidor ni prueba que el contenido binario interno corresponda al lote: esa garantía depende de permisos, SQL y pruebas del backend.

**Para producción sigue pendiente:** staging privado autorizado, aceptación física Chrome Android/Safari iOS, restauración verificable, revisión de seguridad externa, rendimiento y aprobaciones humanas del issue #130. Ninguna CI de este bloque constituye GO por sí sola.
