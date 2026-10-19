# 0T.26 — Ordenamiento operativo global de pendientes

## Operación
La bandeja de coordinación permite ordenar **toda la consulta de la empresa antes de paginar**, no simplemente las 50 órdenes visibles. Los tres criterios son:

- `newest` (por defecto): creación DESC, UUID DESC. Conserva el contrato anterior sin parámetro en URL.
- `due_first`: fecha de vencimiento ASC, fechas `NULL` **al final**; entre vencimientos iguales, creación DESC y UUID DESC.
- `priority_first`: prioridad urgente, alta, normal, baja, luego creación DESC y UUID DESC. Valores inesperados conservan una última categoría de respaldo (no se autoriza editarlos).

Los desempates son deterministas y explícitos: `date_trunc('milliseconds', created_at)` e `id DESC` en todos los criterios; `due_at` también se trunca a milisegundos, pues la API serializa fechas JS en milisegundos y PostgreSQL puede almacenar microsegundos. Un cursor conserva la última clave (`due_at` ISO o NULL, rango numérico de prioridad o NULL para creación), la fecha de creación y el UUID. Esto evita saltos o duplicaciones ante muchas órdenes con igual fecha/prioridad y al pasar desde fechas con valor a fechas sin vencimiento. No promete un snapshot si se editan fechas, prioridades o estados a mitad del recorrido.

## Contrato y seguridad
`GET /api/v1/work-orders/review-queue?sort=due_first`; los filtros globales `q` (título), `type`, `state`, `priority` y `due` se pueden combinar normalmente. Solo `newest|due_first|priority_first`; valores duplicados/array/vacíos/desconocidos y parámetros extra reciben 422. Los ordenamientos son expresiones SQL **estáticas**, sin `ORDER BY` de entrada libre. El `LIMIT 51` y keyset se aplican en PostgreSQL dentro del tenant, con autenticación, rol de coordinación y FORCE RLS; no `OFFSET`, contadores globales ni cargas masivas. El costo del ordenamiento podría crecer con la cardinalidad; rendimiento real pertenece al carril #105.

Cursor HMAC **v7** usa dominio específico y firma tenant, usuario, tipo, estado, prioridad, ventana de vencimiento, consulta textual canónica, **sort**, ancla/expiración y última tupla (incluida clave principal de orden); TTL 15 minutos. Intentar reutilizar un token con otro orden, otra empresa/usuario/filtro, manipularlo o pasar un token v6 recibe HTTP 422 y permite iniciar una nueva consulta. Un cursor **nunca** autoriza aprobar, asignar o cerrar órdenes.

## UX
El selector **Ordenar resultados (todas las páginas)** contiene tres opciones etiquetadas. Cambiar orden reinicia página, limpia la pila de cursores, cancela generación anterior y conserva todos los demás filtros y la búsqueda confirmada; una requestKey incluye sort para no pintar respuestas de otro criterio. Es navegación read-only con control de foco y estados de carga; el detalle revalida autorización y estado. El título, prioridad, tipo y ventana continúan filtrados por SQL.

## QA verificable
- Tests unitarios: enum, rango de prioridad, claves ISO, NULL, desempates, cursores v7 y replay cross-sort.
- PostgreSQL: rol permitido y contratista prohibido, segundo tenant, query `sort` inválida/array/duplicada, combinación con filtros.
- Chromium + Express + PostgreSQL `*_test`: 55 aplicaciones urgentes nuevas y 61 inspecciones normales antiguas; ordenar por prioridad produce páginas 50/50/16, sin mezclar normales con urgentes en la primera; manipular `sort` en una continuación real obtiene 422. Orden por vencimiento produce 50/50/16 con una inspección NULL al final y resto de fechas en orden; filtrar por título y navegar sigue funcionando; volver a recientes reinicia el cursor y restaura el orden previo.
- Exigir gates `tenant-rls` y `browser-offline` sobre HEAD PR exacto y CI posmerge independiente sobre nuevo SHA remoto. El merge no es certificación de release.

## Coordinación y límites
Issue central [#18](https://github.com/FedesConsultora/SedeAgro/issues/18), bloque #112, carril independiente [#105](https://github.com/FedesConsultora/SedeAgro/issues/105) para medir `EXPLAIN (ANALYZE, BUFFERS)` de órdenes por fecha, prioridad y otros filtros con bases PostgreSQL descartables, sin editar rutas funcionales reservadas; #86 conserva QA manual de foco. El otro chat requiere que su agente tome #105 explícitamente, un handoff escrito no lo ejecuta.

No se introducen índices, migraciones, cambios de permisos, auth/RLS, inventario, GIS/scouting, offline, despliegue, staging/VPS/producción ni QA física. Rollback debe revertir cursor v7/API/UI en conjunto.
