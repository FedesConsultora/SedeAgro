# SedeAgro 0T.24 — Vencimientos globales de la bandeja

## Alcance visible
La bandeja de coordinación permite seleccionar el filtro **Vencimiento (todas las páginas)**, combinable con tipo de labor, estado de revisión y prioridad existentes. Las categorías tienen límites exactos:
- **Cualquier vencimiento**: todas las órdenes `in_progress` autorizadas, incluidas las que carecen de fecha.
- **Vencidas**: `due_at < anchor`.
- **Próximas 168 horas**: `anchor <= due_at < anchor + 604800000 ms`.
- **Posteriores a 168 horas**: `due_at >= anchor + 604800000 ms`.
- **Sin fecha**: `due_at IS NULL`.

`anchor` es el instante UTC de inicio de la **primera solicitud**. Las ventanas no son semanas calendario ni expresan SLA, vencimiento contractual o zona horaria del usuario. Un valor igual al instante de referencia **no** es vencido; el límite de 168 horas es **posterior**, no próxima. Las cuatro categorías exclusivas particionan todas las fechas posibles. Se mantiene orden keyset por `created_at DESC, id DESC`, no por plazo o criticidad; no se calculan totales globales.

## API / seguridad
`GET /api/v1/work-orders/review-queue?due=overdue` usa `reviewQueueDueWhere` sobre `work_orders.due_at` en PostgreSQL **antes de LIMIT 51**, dentro del tenant autenticado y con FORCE RLS. `?type=inspection&state=no_report&priority=normal&due=overdue` combina los cuatro criterios en SQL. Solo se admiten `all|overdue|next_7_days|later|unscheduled`; caracteres raros, nombres desconocidos, arrays, duplicados y query params inesperados devuelven 422. Ningún criterio modifica una orden, el calendario o una política de aprobación. Se mantienen `work_orders` entitlement, `orders.write`, rol `tenant_admin/agronomic_coordinator`, RLS, aislamiento de sesión y revalidación al abrir detalle.

## HMAC v5: ventana inmutable y recuperación
El cursor HMAC de 15 minutos firma dominio `sedeagro:review-queue:v5` y contiene `tenantId`, `userId`, `workType`, `reviewState`, `priority`, **`dueWindow`**, `anchor`, `expires` y última tupla del keyset. Una continuación bajo otro filtro, usuario o empresa, tampering o token v4 anterior produce HTTP 422 y acción de reinicio explícito. Esta estabilidad fija la **clasificación temporal**, no congela cambios de estado o plazos editados mientras se navega.

La UI reencola la búsqueda desde página 1 y limpia los cursores cuando cambia `dueWindow`, conservando el resto de filtros. La clave de solicitud incluye la ventana para que HTTP viejo no repinte datos de un criterio anterior; React aborta transportes viejos. Un refresh preserva los filtros elegidos y crea un anchor nuevo. No se presentan totales de toda la empresa ni se realiza aprobación automática.

## Aceptación y límites
- Unit: cuatro ventanas y `all`, inclusividad de bordes, `NULL`, 168 h exactas, validación de fecha, HMAC replay cruzado, query URLs y request key.
- Integración PostgreSQL con RLS: órdenes sin fecha/vencidas/próximas/posteriores, roles permitidos vs contratista, segundo tenant, errores por duplicados/arrays/queries no válidas.
- Chromium real: 61 inspecciones antiguas con fecha vencida, 55 aplicaciones recientes con fecha a 24 h, **overdue 50/11** y **next_7_days 50/5** antes de paginar; filtros `later` y `unscheduled` vacíos; alteración real del cursor a otra ventana devuelve 422; restauración de consulta y aislamiento del segundo tenant.
- GitHub CI previo sobre HEAD exacto y CI posmerge independientes, ambos jobs `tenant-rls/browser-offline`, backup/restauración PostGIS, build, frontend/backend y aceptación Chromium. Logs siempre ligados al SHA comprobado. CI verde **no equivale a staging, producción, QA táctil/VoiceOver o certificación de campo**.

## Carriles paralelos
El otro agente puede abordar [#105](https://github.com/FedesConsultora/SedeAgro/issues/105) sobre `EXPLAIN (ANALYZE, BUFFERS)`, p50/p95, índices y sensibilidad de subconsultas correlacionadas. Reservar archivos nuevos para benchmarking y documentación, sin tocar los paths funcionales de 0T.24 sin un handoff. [#86](https://github.com/FedesConsultora/SedeAgro/issues/86) mantiene la verificación longitudinal de foco y accesibilidad. Toda reserva, merge, SHA, prueba, fallo y archivos liberados se registran en [#18](https://github.com/FedesConsultora/SedeAgro/issues/18). El issue NO activa automáticamente al otro chat.

No se alteran migraciones, índices, infraestructura, RLS, auth, stock, GIS/scouting, offline o producción. Rollback de cursor+API+frontend debe ser atómico, ya que la versión HMAC anterior y el contrato cliente están ligados.
