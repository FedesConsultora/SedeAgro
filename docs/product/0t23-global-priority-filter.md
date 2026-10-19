# 0T.23 — Priorización global de órdenes pendientes

## Resultado funcional
El coordinador puede filtrar la bandeja de órdenes activas por **urgente, alta, normal y baja**, o consultar **todas las prioridades**. El filtro de prioridad actúa **en PostgreSQL ANTES de LIMIT 51**, no sobre los primeros 50 resultados del navegador. Se combina por igualdad con los criterios globales ya existentes de tipo de labor y estado de revisión; la lista sigue ordenada por `created_at DESC, id DESC`, NO por una supuesta prioridad o ranking oculto. Tampoco se ofrecen totales agregados de toda la organización.

La prioridad procede exclusivamente de `work_orders.priority` existente, no de inferencias sobre la fecha o el estado del parte. El usuario no puede cambiar una prioridad desde la bandeja: sigue siendo un navegador de información operativa, no un endpoint de aprobación, asignación o cierre.

## Contrato backend
`GET /api/v1/work-orders/review-queue?priority=urgent` selecciona sólo órdenes urgentes de la empresa autorizada con estado `in_progress`. `priority=normal&type=inspection&state=no_report` combina los tres criterios globales **antes** de keyset pagination.

El servidor admite `all|urgent|high|normal|low` y rechaza con 422 valores desconocidos, arrays/duplicados, vacíos y parámetros inesperados. La autenticación, membresía activa, entitlement work_orders, capability orders.write y rol tenant_admin/agronomic_coordinator siguen siendo obligatorios. FORCE RLS filtra el tenant en todas las consultas; el cursor no concede permisos.

## Cursor v4 y revocación
Para evitar replay entre criterios, el HMAC usa dominio `sedeagro:review-queue:v4` y firma un payload de tenant, usuario, tipo, grupo de revisión, prioridad, ancla, expiración y tupla final. TTL de 15 minutos; modificación de prioridad, tenant/usuario, firma o token legado v3 se rechaza con 422 y la UI ofrece consulta nueva.

Se usa una clave de solicitud con los tres filtros para impedir pintar datos atrasados de otra consulta. Al cambiar la prioridad se conserva el tipo y estado actuales, se limpia el cursor, se vuelve a la página 1 y se cancela la generación previa. Un cambio de tipo conserva la prioridad pero reinicia la selección de estado según el contrato anterior; refrescar preserva los filtros de búsqueda.

## Aceptación
- Tests unitarios: enum exacto, invalidación cross-priority incluso con misma tupla y usuario, alcance tenant, errores 422 y claves frontend aisladas.
- PostgreSQL/PostGIS: prioridades normales/urgentes, combinación tipo+estado+prioridad, roles rechazados, segundo tenant, duplicados/arrays/parámetros no permitidos.
- Chromium real: primero 61 órdenes normales de inspección y 55 órdenes urgentes de aplicación con partes registrados. `priority=normal` debe devolver 50/11, aunque la página sin filtro esté ocupada por aplicaciones urgentes más recientes; `priority=urgent` devuelve 50/5. Alterar prioridad del cursor firmado en HTTP real recibe 422; reinicio y combinación de filtros preservan navegación, sin respuestas inventadas.
- Exigir CI exact HEAD de PR y CI posmerge independiente. Cualquier fallido se documenta; **merged ≠ release certificada**.

## Riesgos y trabajo paralelo
Agregar igualdad en prioridad no resuelve el costo potencial de las subconsultas correlacionadas del filtro de estado. **Issue [#105](https://github.com/FedesConsultora/SedeAgro/issues/105)** está reservado como oportunidad para otro agente: EXPLAIN (ANALYZE, BUFFERS), p50/p95 y recomendaciones de índices con datos desechables, sin solapar los paths de 0T.23. **#86** sigue abierto para seguimiento manual de accesibilidad. Coordinar CLAIM/PR/HEAD en **#18**.

Sin cambios en migraciones, índices, autorización, stock, scouting, GIS, offline, sesiones transversales, workflow, VPS ni despliegues. Rollback conjunto del frontend/backend/cursor v4 mediante revert de los commits de este bloque. No se realizaron mediciones de rendimiento grandes, pruebas VoiceOver/TalkBack manuales ni piloto rural.
