# Piloto — Idempotencia persistente al crear órdenes de trabajo (#204)

**Cadena:** campaña → observación → orden de trabajo → ejecución/revisión. Base `main@49caaff1e87cee21532607da429ac6d45727dcb5`. Coordinación #18, aceptación #166; release #130 NO-GO.

## Defecto y alcance

El endpoint `POST /work-orders` validaba `field_id` y `campaign_field_id` bajo RLS y ejecutaba `WorkOrder.create` con estado inicial draft, sin recuperar el recurso tras un ACK perdido. Una segunda solicitud desde otra pestaña podía crear otra orden con UUID distinto aunque título, prioridad e instrucciones fueran idénticos.

La solución añade `client_request_id: UUID` **opcional**, sin inferir identidad desde `title` ni cambiar la semántica de órdenes legítimas con títulos repetidos.

## Garantías backend

- Para una clave nueva, la reserva transaccional en `work_order_create_requests` usa PK `(tenant_id, requested_by, client_request_id)`. PostgreSQL serializa las solicitudes simultáneas entre workers.
- El fingerprint SHA-256 se calcula después de Zod e incluye lote, asociación de campaña opcional, tipo, prioridad, fecha/hora UTC `due_at`, título, instrucciones y estado draft. Solicitudes semánticamente iguales con distintos offsets de fecha comparten fingerprint; cambios de payload se rechazan con `409 WORK_ORDER_CREATE_REQUEST_CONFLICT`.
- Se verifica `orders.write` y entitlement `work_orders` antes de leer cualquier recibo. Un token por sí solo nunca autoriza el acceso.
- El primer POST con clave devuelve **201** y `replayed:false`; repetir la misma clave/cuerpo/actor/empresa devuelve **200** y `replayed:true` con el UUID original. Sin clave se conserva el contrato de cliente anterior (201 y `data` sin indicador).
- Las claves guardan `work_order_id` por FK compuesto `(tenant_id,id)` y `ON DELETE SET NULL (work_order_id)`. Borrar la orden conserva la clave como tombstone; otra solicitud con ella devuelve `409 WORK_ORDER_CREATE_RESULT_GONE`, nunca crea reemplazo.
- Bajo **ENABLE + FORCE RLS** no hay política runtime DELETE; la migración descendente rechaza borrar una tabla con recibos existentes. `Cache-Control: private, no-store` evita cachés HTTP de la respuesta.
- Validación de lote real y vínculo campaña-lote sigue siendo autoritativa en la ruta para creaciones nuevas. No se altera ninguna orden histórica, asignación o ejecución.

## Pruebas

`backend/test/workOrderCreateIdempotency.pg.mjs` comprueba HTTP real con PostgreSQL/PostGIS migrado y sembrado, rol DB nonowner y FORCE RLS: usuario sin permiso, lote de otra empresa, create/replay exactos, cambios de instrucciones/lote, igualdad por offset horario, actor B, tenant B, simultaneidad de dos workers, cliente legacy, recepción tras cambio legítimo de estado, revocación de membresía y tombstone luego de borrado. Test físico/staging **NOT_RUN**.

## Límites pendientes

El navegador `WorkOrderFormModal` todavía **no envía** la clave ni puede reintentar de forma segura tras timeout; debe implementarse en PR frontend separado una vez integrado este backend y ejecutar 4/4 controles, luego 6/6 de main. Una clave que se mantiene sólo en memoria del modal **no garantiza** reintento tras refresh/cierre/dispositivo distinto. Eso exige política explícita de persistencia y recuperación tenant-safe, sin cookies/tokens en almacenamiento local.

No hay cambios en frontend, auth, RLS de otras tablas, CI, staging ni producción. La falta de invitaciones live #222 y cold-start offline #163 permanecen bloqueos de aceptación P0/P1. No certificar release hasta cerrar #130.
