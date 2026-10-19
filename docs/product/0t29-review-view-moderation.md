# 0T.29 — Moderación excepcional de vistas compartidas

## Propósito y modelo de autoridad
Este bloque añade una facultad específica de administración del tenant: **revocar la visibilidad compartida de una vista publicada por otro administrador de la misma empresa**, sin alterar sus seis filtros, el nombre, su propiedad, otras vistas, el autor o los permisos para consultar órdenes. La vista revocada **sigue existiendo en modo privado** para su propietario y libera una plaza del límite de 20 publicaciones compartidas. El propietario sigue usando el flujo previo de publicación/revocación de 0T.28.

La revocación exige un **motivo concreto y obligatorio de 8 a 200 caracteres**, normalizado NFC, sin caracteres de control; no es un simple switch ni aprobación automática. Los coordinadores pueden aplicar vistas publicadas, pero no administrarlas; los contratistas carecen de acceso. Esta función no comparte nuevas vistas, no transfiere propiedad ni modifica órdenes de trabajo, reportes, aprobaciones, evidence, RLS existente ni permisos.

## Persistencia y auditoría
La migración `202610190003_review_queue_view_moderation_audit.js` crea `work_order_review_view_moderation_audit` con `id, tenant_id, view_id, view_owner_id, actor_user_id, view_name, action='revoke_share', reason, created_at`. Guarda identificadores y motivo para trazabilidad; **no copia filtros, notas, órdenes ni credenciales**. El `view_id` es un dato histórico sin FK a la vista: eliminar posteriormente la vista privada no borra su evento. Solo la eliminación completa del tenant puede retirar su historial (FK `ON DELETE CASCADE`). El rollback de la migración se niega si existen eventos, a fin de no borrar auditoría.

La tabla tiene `ENABLE/FORCE ROW LEVEL SECURITY`, políticas explícitas solo para `SELECT` e `INSERT` del tenant actual, **ninguna** de `UPDATE` ni `DELETE` y un índice `(tenant_id, created_at DESC,id DESC)`. Todas las rutas usan `queryTenantTransaction` con contexto RLS y parámetros SQL escapados. La revocación toma el mismo advisory transaction lock por tenant que la publicación original, después un `SELECT ... FOR UPDATE` de la vista ajena actualmente compartida, efectúa un `UPDATE visibility='private'` y un `INSERT` del evento **en la misma transacción**. Si falla el segundo, no se confirma el primero; un segundo intento sobre la misma publicación encuentra 404 sin duplicar evento.

## Endpoints
Tres endpoints nuevos, todos detrás de módulo `work_orders`, `orders.write`, sesión válida y **rol vigente `tenant_admin`**:

- `GET /api/v1/work-orders/review-queue/views/moderation`: hasta 20 publicaciones **ajenas** del tenant, incluidas las de autores que hayan perdido su rol activo; ofrece solo `id,name,created_at,publisher_active` y jamás retorna criterios ni datos del dueño. Los propios administradores usan sus controles personales existentes.
- `GET /api/v1/work-orders/review-queue/views/moderation/audit`: los 50 eventos de revocación más recientes de la empresa, orden estable descendente. Datos `id,view_id,view_name,actor_user_id,view_owner_id,reason,action,created_at`; sin totales globales ni acceso interempresa.
- `POST /api/v1/work-orders/review-queue/views/moderation/:viewId/revoke`: cuerpo JSON estricto `{"reason":"Vista obsoleta para esta campaña"}`. Se niega a revocar vistas privadas, de otro tenant, propias, inexistentes o ya revocadas sin revelar visibilidad (404); un coordinador obtiene 403, id inválido o motivo inválido 422; el JSON primitivo rechazado por Express puede devolver 400. No permite `visibility`, `filters`, `actor`, `tenant` u otras claves en el cuerpo. Respuesta evento auditado.

Para listados y mutaciones se utiliza `Cache-Control: private, no-store`. Una consulta que devuelve 200 no confiere acceso a contenido de otras empresas ni permite guardar/modificar una orden.

## UX / accesibilidad
La pantalla de coordinación presenta un panel solo al administrador con publicaciones ajenas, estado del rol publicador, campo de motivo, botón **Revisar revocación**, confirmación separada **Confirmar revocación** y **Cancelar revocación**, refresco, mensajes de error/éxito y un historial desplegable de las últimas 50. Cambiar destino/motivo desarma la confirmación. Los formularios usan etiquetas, estados, enfoque visible y objetivos táctiles de al menos 44 px. Tras revocar se quita esa vista de cualquier selección compartida local pero **los filtros de la bandeja y el cursor de consulta vigente no se alteran**. Se recargan inventario/historial desde API, sin `localStorage`.

## QA y límites
- Unitarios de normalización/strict schema, respuesta pública sin filtros, visor y contrato de doble confirmación.
- PostgreSQL/PostGIS real: dueño no puede usar moderación sobre sí, otro admin del mismo tenant puede revocar, rol coordinador/contratista denegado, tenant B nunca ve ni altera la vista o eventos, motivos/control chars inválidos, una sola fila auditoría, vista original privada con propietario y filtros intactos, INSERT y SELECT exclusivamente bajo RLS forzada, re-publicación por autor conserva potestad.
- Chromium/Express/PostgreSQL `*_test`: crear una vista de otro admin con membresía real, listar publicación desde el administrador A, motivo insuficiente no habilita confirmar, cancelar no altera, confirmar revoca, auditoría persiste en PostgreSQL tras recarga, la vista del dueño sigue privada. Aceptaciones previas de paginación, cursor firmado, offline, cross-tenant y sesiones se ejecutan intactas.
- Merge **normal** solo con CI PR exact HEAD `tenant-rls` y `browser-offline` SUCCESS y ejecución de nuevo sobre el SHA de `main`. Una suite verde no representa despliegue a staging, VPS o producción, rendimiento medido en escala, VoiceOver/TalkBack ni aceptación de trabajo de campo.

## Coordinación
CLAIM de archivos/handoff en [#18](https://github.com/FedesConsultora/SedeAgro/issues/18). [#105](https://github.com/FedesConsultora/SedeAgro/issues/105) continúa como carril paralelo de benchmarks EXPLAIN/ANALYZE/BUFFERS en **nuevos** scripts y docs sobre PostgreSQL desechable. [#86](https://github.com/FedesConsultora/SedeAgro/issues/86) registra el seguimiento de foco/lector de pantalla. Ningún issue ni comentario activa automáticamente otro agente.
