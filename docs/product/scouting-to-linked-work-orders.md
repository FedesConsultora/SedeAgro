# Piloto SedeAgro 0.1 · Observación → órdenes vinculadas

**Bloque 0R.6 · 2026-11-03 · Fuente de verdad: main previo 781a2c62864216b3fd5f1338f1d8ccb37c2f768e · Coordinación #18**

## Brecha funcional

0R.3 y 0R.4 permitieron crear una orden de inspección a partir de una observación persistida, con FK compuestas y FORCE RLS, y abrir la recorrida desde el detalle de la orden. Faltaba la relación inversa **desde Monitoreo**: el coordinador no podía verificar si había órdenes reales ya emitidas desde un mismo hallazgo, por lo que podía generar otra por error. No se deben inferir vínculos desde títulos, textos de instrucciones, notas ni IDs arbitrarios.

## Contrato implementado

1. En Monitoreo → recorrida → observación, los administradores de empresa y coordinadores agronómicos que **mantienen simultáneamente** `scouting` y `work_orders` y sesión válida ven **Órdenes de trabajo vinculadas**. La UI no se muestra en demo, en perfiles scout/contratista, en otro tenant o sin alguno de los dos módulos.
2. `GET /api/v1/work-orders/observation-links/runs/:runId` exige `orders.read`, `scouting.read`, módulo `scouting` habilitado, rol de administración/coordinación, `work_orders` habilitado y un run existente bajo **la transacción FORCE RLS del actor**. ID ajeno/ausente → 404; acceso insuficiente → 403.
3. PostgreSQL consulta exclusivamente `work_order_observation_origins` unido a `work_orders` con `tenant_id` y `work_order_id` coincidentes y `scouting_run_id` exacto. Los datos devueltos por orden son `scouting_observation_id`, `work_order_id`, `title`, `type`, `status` y `priority`. No se devuelven notas privadas, coordenadas, fotos, contenidos de archivos ni contactos. `Cache-Control: private, no-store`.
4. Listado acotado a **100 órdenes completas** por recorrida; 101 o más devuelve **409**, nunca un éxito truncado que simule ausencia de órdenes. La relación admite **múltiples órdenes para un mismo hallazgo** cuando es legítimo. Las órdenes antiguas sin FK no se inventan como vinculadas.
5. El frontend valida estructura, IDs de observaciones presentes en la recorrida solicitada, estados, tipos, prioridades, columnas permitidas, duplicados y límite. Un error del endpoint NO se presenta como “sin órdenes”; hay reintento explícito. Cada snapshot lleva actor/membresía/rol/módulos/transporte/recorrida/revisión y se oculta durante cambios de sesión o carga.
6. Pulsar **Abrir orden vinculada** navega mediante `onNavigate('orders',{id})`, sin transmitir notas/fotos/GPS o secretos. `WorkOrdersPage` consulta su propia lista bajo el rol/tenant actuales; `WorkOrderDetailDrawer` revalida `GET /work-orders/:id` antes de mostrar detalle. No hay POST ni creación automática por navegar. La orden puede volver a abrir la recorrida de origen en la dirección anterior.

## Aceptación

- `frontend/test/observationWorkOrderLinks.test.js`: rechazo de actores/entitlements indebidos, respuesta de otra recorrida, observación no cargada, datos secretos, filas malformadas, >100 o duplicadas, fencing por sesión/API/revisión y ruta de navegación.
- `backend/test/workOrderCampaignField.pg.mjs`: dos órdenes de una observación real con FKs, GET desde admin A 200 exacto, sin notas, scout 403, admin B para run A 404, admin A para run B 404, run propio sin vínculos 200 vacío; no mezcla empresas/campañas.
- `scripts/acceptance-browser-evidence-history.mjs`: registro real → observación con evidencia privada → crear una orden una sola vez → abrir origen desde orden → confirmar vínculo inverso desde la observación → abrir la misma orden otra vez → recorrer origen, con una sola fila SQL y sesión real. Nunca se responde 2xx ficticio.
- No se modifica el esquema, la política RLS, los permisos preexistentes, el despliegue ni los controles CI.
- **Release #130 permanece NO-GO**: tests físicos Android/iOS, staging autorizado, validación de seguridad y firmas Product/Security no se reemplazan por CI.

## Alcance de producto futuro

La vista es una consulta de vínculos establecidos desde la creación. Para organizaciones con más de 100 órdenes por recorrida se requiere paginación real con cursor SQL y autorización equivalente, no elevar silenciosamente el límite ni devolver resultados parciales. La vista ayuda a evitar duplicidades humanas, pero **no prohíbe** emitir varias órdenes legítimas para el mismo hallazgo.
