# 0T.6 — PDF/XLSX inmediatos sobre datos reales

## Entrega concreta

Se amplía el reporte por lote del PR #69 para ofrecer **CSV, PDF y XLSX reales** desde la misma autorización de `reports.read` y la misma transacción PostgreSQL tenant/RLS. No se cambian derechos ni tablas.

- **CSV:** se preserva el formato real del bloque 0T.5.
- **PDF:** documento PDF 1.4 A4 multipágina generado en servidor con texto de lote, observaciones, órdenes, período y recuentos. Usa Helvetica WinAnsi; si una nota contiene un carácter fuera de WinAnsi, rechaza con 422 y orienta a XLSX/CSV, **sin sustituir ni ocultar caracteres silenciosamente**.
- **XLSX:** archivo OpenXML ZIP real de una hoja, con fila de encabezados, filtro y encabezado inmovilizado. Todas las celdas se escriben como `inlineStr`, jamás fórmula. Admite Unicode, incluye emoji y sanitiza controles XML ilegales. No permite macros, enlaces externos ni fórmulas.
- Los documentos regresan mediante respuesta JSON autenticada con contenido binario base64, nombre MIME y longitud. La interfaz valida el MIME/tamaño/firma PDF o ZIP, vuelve a comprobar identidad de sesión y recién entonces ofrece la descarga mediante Blob y URL temporal. Las respuestas llevan `Cache-Control: private, no-store`.
- Las fechas se interpretan en días UTC inclusivos; observaciones por `observed_at` y órdenes por `created_at`.
- Los límites siguen siendo **200 observaciones, 200 órdenes y 1 MiB en el snapshot CSV**. PDF máximo 80 páginas y 3 MiB, XLSX máximo 3 MiB; excederlos produce 413 y no un archivo truncado.

## Por qué no se creó un worker engañoso

La tabla `report_runs` puede representar queued/running/completed/failed, pero el código previo solo crea filas `queued`; **no hay agente de procesamiento, storage de resultados ni política de expiración/retención asociada**. En 0T.6 el endpoint POST `/reports/runs` **deja de fingir aceptación (202)**: devuelve 409 `REPORT_WORKER_NOT_AVAILABLE` y no persiste trabajos que nadie ejecutará. Por eso 0T.6 expone generación **síncrona acotada**, con botón Generando… y archivo real o error real. La UI no la anuncia como trabajo en background.

La cola de reportes PDF/XLSX (plantillas, generación por campaña/productor, auditoría, digest del archivo, persistencia cifrada, transiciones transaccionales, entregas por email, límites de concurrencia y cancelación) sigue pendiente de diseño e implementación separada. No se declara cubierta por este bloque.

## Contrato funcional

| Ruta | Protección | Resultado |
| --- | --- | --- |
| `GET /reports/field/:fieldId/export.csv` | reports.read + tenant RLS | CSV UTF-8 + BOM |
| `GET /reports/field/:fieldId/export.pdf` | reports.read + tenant RLS | PDF base64 en `data.content_base64` |
| `GET /reports/field/:fieldId/export.xlsx` | reports.read + tenant RLS | XLSX OOXML base64 en `data.content_base64` |

Para las tres rutas `from` y `to` son opcionales. Lote ajeno/inexistente → 404; rol sin capacidad → 403; fechas inválidas → 422; exceso de datos/bytes → 413. Un error nunca se representa como archivo vacío exitoso.

## Pruebas automatizadas

- Unit tests de PDF: cabecera `%PDF-1.4`, catálogo, páginas A4, caracteres latinos, integridad `xref`, exceso de páginas y rechazo de Unicode no compatible.
- Unit tests de XLSX: firma ZIP, estructura XML, `inlineStr`, Unicode/no fórmula, cabeceras/estilos, rechazo de XML ilegal.
- Tests de descarga UI para firmas, MIME, longitud, tamaños, cross-session y sin exportación mock.
- PostGIS real de dos empresas, sesiones con y sin `reports.read`, fechas, contenido sin otro tenant y respuestas no-cache, reutilizando el caso 0T.5; suite repetida sobre la base restaurada del bloque 0T.4.
- CI `tenant-rls` y `browser-offline` en HEAD exacto PR + post-merge, sin despliegue.

## No afirma

No representa evaluación de calidad visual mediante Safari/iOS/Android físicos, staging ni PDF de firma legal. El PDF utiliza fuente WinAnsi limitada, y los XLSX todavía no incluyen gráficos/tablas dinámicas ni fórmulas calculadas. No existe todavía reporte programado por lotes grandes ni automatización de mailing.

Siguientes gates: exportación por campaña/cliente, procesamiento asíncrono con durable storage y políticas de descarga, flujo integral empresa-lote-monitoreo-orden-reporte en staging y móviles reales.
