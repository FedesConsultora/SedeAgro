# SedeAgro 0.1 · Reportes → revisión de ejecuciones pendiente

**Bloque funcional 0R.8 · 2026-11-04 · Coordinación #18 · Release #130 NO-GO**

## Brecha verificada en el código

Los reportes de lote (bloque 0R.7) muestran las ejecuciones y sus estados de revisión en archivos CSV/PDF/XLSX, pero la pantalla **Reportes** sólo exhibía órdenes abiertas/cerradas, observaciones y cinco órdenes recientes. No mostraba **trabajos efectivamente declarados que aún requieren revisión independiente**, ni permitía saltar desde ese lote hasta la orden que hay que revisar. El carril de revisión ya existe en **Órdenes de trabajo** y no se duplica.

## Qué implementa

1. `GET /api/v1/reports/field/:fieldId` mantiene su permiso `reports.read`, módulo `reports`, transacción actual y validación de lote de la empresa; suma `reviewSummary`: `submitted` (declaraciones pendientes), `verified` (verificadas), `rejected` (rechazadas) y `recentPending` (hasta **cinco**).
2. Los conteos provienen exclusivamente de `work_order_executions.review_status`, unidos por claves compuestas `tenant_id + work_order_id` a `work_orders` del lote; ambas tablas están protegidas por **FORCE RLS**, incluso para el rol PostgreSQL no propietario. La consulta de acciones está limitada SQL `LIMIT 5` y ordenada por `finished_at DESC, execution.id DESC`. Los conteos son exactos, no recuentos de cinco filas.
3. Cada acción ofrece sólo `execution_id`, `work_order_id`, `field_id`, `title` de la orden y `finished_at`. No se consulta ni devuelve `submitted_by`, `review_note`, `review_checklist`, datos de insumos, resultados, identidad de revisores/operarios, evidencia, coordenadas GPS, fotografías, ni sus bytes.
4. El cliente valida de forma estricta los cuatro contadores/campos, máximo cinco acciones, UUIDs, pertenencia al lote elegido, fechas y ausencia de claves inesperadas. Si falta el resumen no muestra un falso cero: la consulta se considera inválida y ofrece reintento. El estado cargado ya está cercado por empresa, actor, membresía, rol, entitlements, lote y transport/API.
5. La tarjeta de lote presenta `Pendientes de revisión`, `Verificadas`, `Rechazadas` y los **cinco pendientes más recientes**. Sólo con sesión live, rol admin/coordinador, módulo reportes Y módulo órdenes, ofrece **Abrir orden para revisar**.
6. El botón delega `onNavigate('orders', {id})` al Shell. El Shell aplica `canNavigateView`; `WorkOrdersPage` consulta su propia colección autorizada (y falla visiblemente si no encuentra ID); `WorkOrderDetailDrawer` revalida detalle exacto. El informe **no hace POST/PATCH de revisión ni cierre**, ni interpreta «submitted» como «verified».
7. La pantalla Reportes informa que los conteos son de ejecuciones declaradas en el servidor, sin filtro temporal, y que no certifican una operación agrícola en el terreno. Exportar el archivo con fechas sigue siendo una acción independiente.

## Aceptación

- Unit frontend: invalidar sesión/rol/membresía/entitlements/tenant/API, 6 filas, duplicados, otra parcela, campos privados, UUIDs malformados, conteos incompletos, sin permitir navegación cuando no existe autoridad.
- PostgreSQL no-owner: camino real contratista envía ejecución → el reporte muestra `submitted:1`/última orden/ejecución UUID → revisor distinto confirma → `verified:1`, `submitted:0`, lista vacía. Contratista 403 y empresa ajena 404.
- PostgreSQL adversarial: 7 ejecuciones reales pendientes en un lote; exactamente 7 en conteo y máximo 5 acciones; una verificada y una rechazada actualizan los tres conteos, sin filtrar notas privadas y sin mezclar empresas.
- Chromium real con sesión/cookie y PostgreSQL descartable: observación privada → orden persistida → ejecución pendiente de un contratista distinto → Reportes → resumen real → botón abrir la misma orden → detalle autorizado → Monitoreo. No crea una orden adicional.
- PR exact-head 5/5, merge normal, main push independiente 7/7. No despliegue ni aprobación de release.

**Release #130 continúa NO-GO.** Pruebas físicas Android/iOS y staging autorizado con firmas de Product/Security/Operations no son sustituidos por tests CI.
