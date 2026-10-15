# 0T.9 — Parte de ejecución declarada, revisión y cierre administrativo

## Objetivo
Convertir el cambio `in_progress → completed` en una transición con registro operativo y revisión independiente. **Una declaración no prueba por sí sola que se trabajó físicamente**: SedeAgro diferencia al ejecutor que informa, al revisor y al usuario que cierra la orden. No hay validación GPS, satélite, telemetría ni certificación automática.

## Uso por rol
1. Un contratista con asignación vigente, administrador o coordinador inicia la orden con el workflow existente. La orden debe estar en `in_progress` y haber sido aprobada.
2. En el detalle real, **Parte de ejecución** exige inicio/fin explícitos, superficie declarada en ha, resultado observado y confirmación de autoría. No se completan horas ni resultados automáticamente. Se registra quién presentó el parte y cuándo lo envió al sistema.
3. Mientras exista una declaración **submitted** no se puede crear otra ni completar la orden. Coordinación puede **verified** o **rejected**; en rechazo exige motivo (10–500 caracteres). La misma identidad que presentó el parte no puede revisarlo aunque sea admin.
4. El reporte rechazado permanece histórico e inmutable; se permite presentar una versión nueva (límite 20 por orden). La revisión **verified** habilita exclusivamente a coordinación el botón **Completado**; el backend vuelve a verificarlo transaccionalmente.
5. La orden completada no admite nuevos partes ni revisiones. Los partes históricos siguen visibles a usuarios autorizados de esa empresa (contratistas solo cuando asignados).

## API y almacenamiento
- `POST /api/v1/work-orders/:id/executions` — `orders.execute`, contrato `started_at` y `finished_at` ISO8601 con offset, `worked_area_hectares` positivo y `result_summary` 10–2000 chars. 201 si se persiste; 422 inválido; 403 rol no autorizado; 404 otro tenant; 409 fuera de estado, duplicado o límite histórico.
- `POST /api/v1/work-orders/:id/executions/:executionId/review` — `orders.write`, `decision: verified|rejected`, `reason` obligatorio solo para rejected. 403 autocertificación, 404 IDs ajenos, 409 ya revisado/cerrado.
- `GET /api/v1/work-orders/:id` incluye `WorkOrderExecutions` (historial hasta 20 registros, ordenado descendente) bajo la política de lectura existente.
- `PATCH /api/v1/work-orders/:id/status` no permite completed hasta existencia de parte verified y rol coordinador/admin. No hay bypass por usar API directa.
- Tabla nueva `work_order_executions`: FKs compuestas por `tenant_id` a work_orders/memberships, FORCE RLS, índice único parcial para un parte submitted/verified por orden, checks de tiempo/revisión. Las declaraciones no se modifican ni se eliminan desde la API; solo se actualizan columnas de estado de revisión. El rechazo conserva los valores originales.
- Todas las mutaciones usan el bloqueo `FOR UPDATE` sobre la orden para serializar declaración/revisión/cierre y `audit_events` transaccionales **sin copiar resultados, notas ni coordenadas**. El envío perdido puede recuperarse recargando la orden (409 si ya existe), nunca se crea un reporte silenciosamente.

## Pruebas
- Backend unit: permisos, no autocertificación, validación de intervalos, completion fence.
- Frontend unit: UI solo live, elegibilidad y ausencia de botón de cierre antes de un parte verified, respuestas del servidor verificadas.
- PostgreSQL/PostGIS: suite `assignmentNotifications.pg.mjs` extendida con contratistas/admin/coordinador y tenants A/B, review/reject/retry, auditoría, estados terminales y lectura RLS. Inventario global `tenantIsolation.pg.mjs` exige FORCE RLS a la tabla nueva; original y restaurado en CI.
- GitHub Actions verifica unit, build y Chromium en HEAD literal; iPhone/Android físicos, conectividad rural y piloto NO ejecutados.

## Migración y rollback
`202610150003_work_order_executions.js` crea una tabla sin alterar datos existentes ni convertir órdenes viejas a completadas. **Ordenes anteriores en estado completed no reciben un parte ficticio**. La migración `down` falla deliberadamente si hay registros: primero se debe preservar/exportar información y acordar un procedimiento de conservación. Para revertir código, usar PR + tests en el HEAD exacto; no ejecutar `DROP TABLE` sobre reportes de usuarios.

## Límites posteriores
La revisión es responsabilidad administrativa, no certificación de presencia o trabajo físico; faltan adjuntos/evidencia multimedia privada vinculada al parte, conciliación de superficie con mapas PostGIS y control de insumos, máquinas y costos efectivamente usados. Sin sync offline de órdenes antes de auditar el motor. El siguiente bloque 0T.10 podrá agregar respaldo multimedia autenticado a estos partes, preservando privacidad y sin reutilizar evidencias de monitoreo como prueba automática de ejecución.
