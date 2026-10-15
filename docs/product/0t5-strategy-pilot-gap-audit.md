# 0T.5 — Brechas funcionales frente al documento estratégico SedeAgro

**Fecha:** 15/10/2026  
**Fuentes:** *Sede Agro - Plataforma SaaS AgTech, Documento estratégico y de definición de proyecto*, 9/04/2026, en especial §§2, 7–10 y tablas «Módulos funcionales recomendados» y «Fases». Contraste con el código de `main` previo `620dfd65ed5fde669f06468b62fc2e334c46c674` y los PR 0S–0T.

**Principio:** no confundir disponer de una tabla/API o una vista ilustrativa con una funcionalidad completa. Tampoco confundir CI/PostGIS/Chromium con QA físico o staging. El documento es una propuesta de alcance por fases, no una afirmación de que el código ya lo cumple.

| Área de la estrategia | Evidencia de implementación | Brecha para piloto/V1 |
| --- | --- | --- |
| Organizaciones, RBAC, equipos, multiempresa | `auth`, `teams`, capabilities, membresías, PostGIS FORCE RLS, revocación/cookies | Auditoría operativa y aceptación de roles; asesor externo con límites por cliente/lote no es un actor plenamente resuelto |
| Establecimientos y lotes GIS | `farms`, `fields`, PostGIS, `FieldGeographyPanel` | QA espacial real con polígonos complejos, geometrias inválidas, móviles y datos de campo |
| Campañas, cultivos | `campaigns`, `campaign_fields`, catálogos | Profundizar objetivos productivos, responsables/calendario y validación real |
| Monitoreo offline | `scouting`, cola AES-GCM, sincronización idempotente, puntos GPS voluntarios, fotos | **Audio no implementado** en captura real; QA físico offline Safari/iPhone y Android/red rural todavía NOT_RUN |
| Evidencias, waypoints | Fotos y documentos protegidos, integridad/provenance y lectura por recorrida, puntos geométricos | Adjuntos audio y rutas online de sanitización/retención requieren diseño; GPS físico aún NOT_RUN |
| Órdenes de trabajo | Estados, asignados, restricciones de transición, notificaciones, máquinas e insumos | Validar flujo integral con contratista en campo, aprobaciones y trazabilidad real |
| Dashboard analítico | `Dashboard` + operaciones verificables | Indicadores agronómicos históricos/semáforos basados en evidencia requieren reglas del dominio, no métricas ficticias |
| Satélite/imagery | `imagery`, modelos de metadata de capas | **Sin pipeline proveedor Sentinel/Landsat** ni NDVI/GNDVI calculado automáticamente |
| Lluvias/riego | Registros `rainfall_events`, `irrigation_events` y endpoints por lote | Sin integración operativa con sensores ni auditoría física de mediciones |
| Integraciones ERP/ISOBUS | Modelo de integraciones y capacidad de APIs | **Conectores a proveedores reales y estándar ISO 11783 no implementados** |
| Reportes PDF/Excel/CSV por período | `GET /reports/field/:id` resumen; `report_templates/report_runs` y trabajos `queued`. **0T.5 incorpora primer CSV de lote/período real** | **No hay worker PDF/XLSX, emails automáticos ni programación.** Falta campaña/productor, histórico agregado y generación asíncrona |
| Disponibilidad y operaciones | CI RLS, Chromium, recuperación de IndexedDB, manifests SHA, ensayo restore desechable 0T.4 | Sin staging real, restore/rollback real, medición de disponibilidad ni ensayo de recuperación contra datos reales |
| Aplicación nativa/híbrida | SPA responsive + offline browser y captura móvil en Web | **No hay aplicación React Native/Flutter liberable** ni certificados iOS/Android físicos |

## Capacidad añadida en 0T.5: primer entregable comercial de reportes

Se agrega `GET /api/v1/reports/field/:fieldId/export.csv?from=AAAA-MM-DD&to=AAAA-MM-DD` (rango opcional). Sólo roles `reports.read` bajo `reports` habilitado y transacción con RLS. Devuelve CSV UTF-8 con BOM como documento descargable desde `FieldReportCard`, construido a partir de **observaciones reales y órdenes del lote**. Para cada fecha se usan límites UTC: observación por `observed_at`, orden por `created_at`, con día de fin inclusivo. Sin inventar datos ni sumar fotos, audio o documentos privados al archivo.

El archivo lleva cabecera explícita, fila del lote y filas por evento; protege celdas de fórmulas (\`= + - @\` incluyendo prefijos en blanco), escapa comillas y admite acentos. Cada tipo admite como máximo 200 registros; si hay más, la API responde 413 y **no trunca**. Se rechaza archivo total superior a 1 MiB. Fechas inválidas devuelven 422; lote ajeno 404; rol sin permiso 403. Todas las respuestas de exportación privada usan `Cache-Control: private, no-store`.

Este CSV **no equivale** a automatización PDF/Excel, comprobación agronómica, firma de reporte ni envío por email. Un archivo abierto en Excel continúa siendo un CSV, no una planilla XLSX certificada.

## Próximos bloques — orden de valor, no de cantidad de features

1. **0T.6:** reportes PDF/XLSX generados realmente a partir de snapshot tenant-scoped, con worker/cola, estado/descarga autenticada y límites de procesamiento; separar formatos y descargas del flujo HTTP transaccional.
2. **0U:** matriz end-to-end de camino crítico `empresa → lote → campaña → recorrido → foto/offline → evidencia → orden → reporte` por rol, control de latencia y tratamiento de fallos.
3. **0V:** decisión explícita sobre audio, exportaciones por campaña/productor y límites de acceso por cliente/asesor (sin permitir sobreexposición de datos).
4. **0W:** capas satelitales reales / integraciones sólo tras disponer de credenciales, costos, contratos y proveedores verificados; no simular NDVI.
5. **Piloto:** hardware físico Safari/Android, red rural, staging independiente, backup/restore real, rol runtime, observabilidad y go/no-go formal siguiendo `docs/ops/0t3-staging-release-gates.md` y `0t4-disposable-restore.md`.

## Criterio de cierre de este bloque

PR separado, commits atómicos, `main` remoto como autoridad, CI `tenant-rls` y `browser-offline` sobre SHA exacto del PR y post-merge. Pruebas unitarias de CSV/fechas/fórmulas, PostGIS real con dos tenants y rol sin permiso; browser/UI test de wiring. Sin migraciones, cambios de permisos, deploy ni afirmación de «piloto listo».
