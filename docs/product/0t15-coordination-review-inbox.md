# 0T.15 — Bandeja de coordinación de órdenes de trabajo

## Necesidad verificada en main
Antes de este bloque las órdenes tenían un listado general y cada detalle incluía 0T.8–0T.14, pero coordinación debía abrir una por una para descubrir si faltaba un parte, insumos o evidencia, si había excepciones pendientes/rechazadas o si ya existía un parte verificado listo para considerar el cierre. Ninguna de las tarjetas de estado por sí sola daba esa visibilidad.

## Funcionalidad real
`GET /api/v1/work-orders/review-queue?page=0` proporciona una página acotada (**50 órdenes en curso**, máximo página 1000) ordenada por creación descendente e ID, con `pagination: {page,page_size:50,has_more}` y `Cache-Control: private, no-store`. Solo cuentas activas con entitlement `work_orders`, capability `orders.write` y rol `tenant_admin` o `agronomic_coordinator` pueden acceder. La consulta deriva sus resultados de datos persistidos bajo FORCE RLS, siempre `tenant_id = req.tenantId`. Un contratista o scout obtiene 403, un tenant ajeno no recibe registros de otro tenant.

La consulta de órdenes, partes en `submitted/verified`, insumos del plan, excepciones y metadatos de adjuntos es **bounded**. Se agrupa por parte vinculada a la orden, sin exponer el contenido privado de notas, detalles de aplicación, cantidad, hash, rutas, ni datos de otro tenant. Los campos devueltos por ítem son `id,title,type,priority,due_at,status,report_id,state,reason`. La bandeja solo devuelve órdenes `in_progress`; completadas/canceladas no consumen espacio.

Los estados orientativos son:
- `awaiting_report`: todavía no hay parte.
- `self_authored`: el revisor actual presentó el parte; otro actor autorizado deberá revisarlo.
- `awaiting_inputs`: el plan tiene insumos que todavía no fueron declarados por el autor.
- `rejected_exception`: una excepción fue rechazada; corresponde rechazo y nueva presentación.
- `pending_exception`: una excepción de insumo no previsto sigue pendiente.
- `awaiting_evidence`: aplicación o fertilización carece de respaldo privado.
- `human_review`: candidato para revisión humana, **no verificado**; falta completar checklist y corroborar integridad/pertinencia de archivos al intentar aprobar.
- `ready_for_closure`: parte ya verificado de modo independiente, coordinación puede **evaluar** pasar la orden a completada.

La clasificación siempre es **informativa** y no reemplaza el row-lock, permisos vigentes, validación de roles, CHECK de integridad ni comprobación SHA-256 del endpoint de revisión real. La sola presencia de un adjunto no significa que su hash o contenido sea válido. La sola declaración de cantidades no prueba consumos físicos.

## Experiencia
La página Órdenes de trabajo agrega una sección “Pendientes de coordinación” únicamente para roles permitidos en sesión **live**. Se muestran estados, razón en español, botón “Abrir orden y comprobar” que recupera el detalle **autorizado** desde el backend, y controles de página anterior/siguiente. El listado no contiene acciones de aceptar, cerrar ni alterar resultados. Los errores, cargas y páginas vacías no se convierten en datos demo.

Cada nueva consulta limpia el listado anterior y cancela actualizaciones React de resultados antiguos con cleanup de efecto, incluyendo cambios de usuario/tenant o navegación de página. El contrato HTTP valida ítems, estados y paginación; una respuesta inválida se trata como error visible.

## Pruebas, seguridad y límites
- Unit backend: todas las categorías, validación fail-closed ante datos incompletos, rechazo de "aprobación automática" implícita y minimización de metadata privada.
- Unit frontend: acceso admin/coordinador solo live, respuesta acotada y estricto servidor, cambio de página/cuenta, errores visibles y drilldown sin aprobar.
- PostgreSQL real 2 tenants: endpoint 200 coordinación, 403 contractor/scout, tenant B no ve A, cache no-store, page inválida 422, y cambios reales `awaiting_report → human_review`, `awaiting_evidence`, `awaiting_inputs`, `pending_exception`, `human_review → ready_for_closure` y exclusión después de completar.
- GitHub Actions: backend unit, frontend unit+React build, PostGIS real/backup-restore/FORCE RLS, Chromium cookie/session/evidence y navegador offline, exact-HEAD PR y posmerge. Gates físicos de campo, móvil/tablet, conectividad rural y despliegue no ejecutados.

## Consideraciones de operación
La paginación por offset acotada no garantiza una fotografía estable si aparecen nuevas órdenes mientras el usuario navega; actualizar vuelve a consultar. No se calculan totales globales inventados. El endpoint no es una API pública de telemetría ni promete que todas las órdenes estén verificadas. Si crece el volumen, considerar cursor estable y métricas de estado agregadas **sin exponer identidades privadas**. La integración con alertas/notificaciones automáticas y flujos de aprobación por lote requiere otro contrato de seguridad.

No se modificaron auth, RLS/migraciones, offline, GIS, scouting, inventario, almacenamiento de evidencias, reportes, infraestructura ni producción.
