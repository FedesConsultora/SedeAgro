# SedeAgro 0.1 — Reporte de ejecución y revisión independiente por lote

**Bloque 0R.7 · 2026-11-03 · Issue de coordinación #18 · Release #130 NO-GO**

## Problema identificado al reconciliar código y alcance

El piloto ya persiste observaciones, recorridas, evidencia privada, órdenes, ejecuciones declaradas por un ejecutor y su revisión separada (estados `submitted`, `verified`, `rejected`). La FK `work_order_observation_origins` permite consultar ambos sentidos observación ↔ orden. Sin embargo, **la exportación de lote CSV/PDF/XLSX sólo incluía observaciones y órdenes**, incluso si la ejecución fue reportada y revisada. Esto hacía que el reporte final no acreditara la última etapa del flujo sin consultar el detalle de cada OT.

## Entrega nueva

1. El snapshot compartido `loadFieldReportSnapshot` ahora consulta `work_order_executions` **dentro de la misma transacción tenant FORCE RLS**, con JOIN a `work_orders` por `tenant_id` y `work_order_id`, y JOIN opcional a la tabla FK de orígenes. Toda fila debe pertenecer al lote actual. Es una lectura; no recalcula, aprueba, rechaza ni recrea trabajos.
2. **Fechas UTC independientes**: observaciones por `observed_at`, órdenes por `created_at`, **ejecuciones por `finished_at`**. Una OT de septiembre con ejecución terminada en noviembre entra en el informe de noviembre como `ejecucion` sin falsificar que la orden fue creada en noviembre. El estado de revisión es el vigente en el momento de emitir el archivo.
3. `ejecucion` es un nuevo tipo de fila explícito, añadido a CSV/XLSX y sección PDF «EJECUCIONES DECLARADAS Y REVISIONES». Incluye ejecución UUID, OT UUID, tipo/prioridad de OT, tiempo de inicio/fin UTC, hectáreas **declaradas**, resumen del ejecutor, `review_status` exactamente `submitted`/`verified`/`rejected`, `reviewed_at` real sólo si existe, y UUIDs de observación/recorrida sólo si hay vínculo verificado en DB. No se infiere vínculo para órdenes antiguas ni se declara automáticamente verificada una presentación pendiente.
4. **Sin fuga de información privada**: se excluyen `review_note`, `review_checklist`, `input_declaration`, identidad de revisores o ejecutores, fotografía, bytes, firmas, contenido de evidencia y coordenadas GPS. El reporte conserva notas de observación previamente autorizadas por `reports.read`, sin ampliar su permiso.
5. El mismo conjunto de datos alimenta descargas inmediatas CSV/PDF/XLSX y procesamiento programado `reportWorker.js` (que ya consume ese snapshot). No hay cambio de esquema, nuevas rutas ni ampliación de permisos.
6. CSV: cabeceras de 15 columnas, comillas + neutralización de fórmulas. XLSX: `inlineStr`, sin fórmulas/macros, autofiltro hasta columna O, preservación Unicode. PDF: texto completo con límites existentes, rechazo explícito de caracteres WinAnsi no representables. Se preservan límites de 1 MiB CSV, 3 MiB PDF/XLSX.
7. Los tres tipos de registro tienen **máximo 200 filas cada uno** y se consulta `201` para detectar sobrecupo. Si excede, HTTP 413 / worker falla: nunca se entrega un reporte incompleto como «éxito». El recibo de exportación incluye `counts.executions`; el frontend verifica ese entero y muestra el conteo tras descargar.

## Aceptación cubierta

- Pruebas de contenido backend: los tres estados de revisión aparecen individualmente, fecha real de revisión no inventada para `submitted`, resumen fiel con neutralización de fórmula CSV, 15 columnas y PDF/XLSX con estado/área/OT/origen; nunca nota privada del revisor.
- Prueba PostGIS de camino crítico: crear observación + evidencia privada → orden vinculada → contratista declara ejecución real → administrador diferente verifica → exportar CSV, PDF y XLSX → verificar ejecución UUID/1.25 ha/estado `verified`/OT/origen; scout 403 y otra empresa 404. Prueba adicional: actualizar `created_at` de OT descartable a un año anterior y comprobar que el reporte del día de `finished_at` contiene ejecución, pero no orden creada en ese período.
- Descarga frontend: contador de ejecuciones obligatorio, número 0–200 y rechazo de metadatos incoherentes antes de ofrecer PDF/XLSX; mismo control para CSV.
- CI real exact-head (PR y main independiente) requerida antes de considerar aceptado este bloque.

## Lo que **no** se puede afirmar

`verified` indica una **revisión independiente en el sistema** del resultado declarado, no un sensor ni certificación física de aplicación agrícola. Este desarrollo no certifica staging, conectividad en campo, dispositivos Android/iOS, integridad presencial del operador ni aprobaciones Product/Security/Operations. El release #130 sigue **NO-GO**.
