# Bloque 0G — Recorridas asignadas, visibilidad por lote y fotografías privadas

## Qué quedó operativo

El responsable del monitoreo ahora se selecciona por **nombre** entre miembros activos del tenant con roles `scout` o `agronomic_coordinator`. Los usuarios bloqueados, inactivos o de otro tenant no pueden ser asignados.

Un administrador/coordinador puede:
- crear recorridas planificadas con o sin responsable; las recorridas `in_progress` requieren uno;
- asignar, cambiar o liberar al responsable mientras la recorrida siga `planned`;
- iniciar, completar o cancelar recorridas conforme a las transiciones autorizadas.

Un `scout` asignado puede:
- consultar sus recorridas;
- registrar observaciones y adjuntar evidencias en recorridas abiertas;
- iniciar `planned → in_progress` y completar `in_progress → completed` **solo las asignadas**, a través de `PATCH /api/v1/scouting/runs/:id/status`;
- consultar únicamente los lotes, establecimientos y campañas que tengan al menos una recorrida asignada, incluida su información histórica.

El `scout` no puede planificar, cancelar, reasignar ni consultar recorridas de otros usuarios. La revocación por reasignación se verifica en la siguiente petición: el anterior responsable pierde lectura de la recorrida y del lote si no conserva otras asignaciones.

## Rutas

- `GET /api/v1/scouting/assignees`: candidatos activos, `scouting.plan`.
- `POST /api/v1/scouting/runs`: creación de recorrida; validación de rol/membresía del responsable y requisito de responsable si inicia en curso.
- `PATCH /api/v1/scouting/runs/:id`: planificación, cambio de responsable, fecha, resumen y estados bajo `scouting.plan`. **No se permiten reasignaciones tras iniciar**.
- `PATCH /api/v1/scouting/runs/:id/status`: `scouting.observe`, únicamente iniciar/completar y comprobando responsable.
- `GET /api/v1/fields`, `/fields/:id`, `/farms`, `/farms/:id`, `/farms/producers`, `/campaigns`, `/campaigns/:id`, `/campaigns/fields`: para `scout` estos endpoints se filtran por el conjunto de lotes obtenido de `scouting_runs.assigned_to` y `campaign_fields.field_id`. No se muestran lotes no asignados mediante asociaciones anidadas.
- `POST /api/v1/fields/:id/rainfall` y `/:id/irrigation`: el monitoreador solo puede escribir en lotes de su conjunto de asignaciones. Un lote fuera de alcance retorna 404.

Estos controles coexisten con el RLS de PostgreSQL y las capacidades por rol; **RLS continúa separando tenants y la política de recurso separa lotes dentro de cada tenant**. Los datos visibles por productor (`producer_viewer`) siguen regidos por `producer_access_grants`, no por asignaciones de monitoreo.

## Concurrencia

Las operaciones de observación, adjunto, cambio de responsable y transición de estado toman un bloqueo `SELECT ... FOR UPDATE` sobre la recorrida, dentro de la misma transacción SQL/RLS que envía la respuesta después del commit. Esto serializa cierre vs. registro de datos y evita añadir una observación a una recorrida cerrada debido a una lectura obsoleta.

## Fotografías privadas

La interfaz ofrece vista previa de JPEG/PNG/WebP en un `Blob` temporal generado en el navegador a partir de `GET /scouting/evidence/:id/content` autenticado, y libera la URL de objeto al cerrar el diálogo. PDFs continúan siendo descargables, no se ejecutan ni muestran dentro del sitio. Ningún archivo privado se publica como URL permanente ni se intenta mostrar en modo mock.

El acceso a `bytea` quedó encapsulado en `backend/src/modules/scouting/evidenceStorage.js` (`putPrivateEvidence`, `getPrivateEvidence`), siempre vinculado a tenant y transacción. Este es un **límite de almacenamiento intercambiable**, no una implementación de S3/MinIO. El máximo sigue siendo 2 MiB por archivo y no hay antivirus ni cuotas agregadas.

## Verificaciones

La suite PostgreSQL/PostGIS cubre dos tenants y distintos responsables de una misma empresa, selectores y detalles de lotes/campañas, escrituras de lluvia/riego, reasignación con revocación inmediata, transición exclusiva del responsable, y permanencia del contenido privado de evidencias. El workflow continúa exigiendo build React y pruebas unitarias.

**No desplegar al VPS sin backup, variables y migraciones previas descritas en `docs/security/postgres-rls-runbook.md`.** Todavía deben auditarse los permisos de lectura de otros módulos (por ejemplo, catálogos y sync), introducir cuotas por tenant y completar un motor de almacenamiento externo para evidencias pesadas.
