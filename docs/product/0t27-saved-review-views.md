# 0T.27 — Vistas guardadas de coordinación (persistentes)

## Objetivo y alcance
Los coordinadores y administradores de empresa pueden guardar hasta **10 combinaciones personales** de criterios de la bandeja de órdenes en curso. Cada vista registra exactamente: `workType`, `reviewState`, `priority`, `dueWindow`, `titleQuery` canónica y `sortMode`. Un nombre de 2–48 caracteres identifica cada combinación. Guardar no modifica ninguna orden, parte, permiso, fecha, revisión o prioridad y **no almacena resultados, IDs de órdenes, cursores HMAC, tokens ni datos de evidencia**.

La persistencia es PostgreSQL de la aplicación, no `localStorage`. Las vistas se recuperan en una nueva sesión en cualquier navegador con las credenciales y el tenant correctos. No se comparten con compañeros de la misma empresa por defecto.

## Backend y permisos
Migración `202610190001_review_queue_saved_views.js` agrega tabla `work_order_review_views`, FK compuesta `(tenant_id,user_id) -> memberships(tenant_id,user_id)`, índice único tenant/usuario/nombre sin sensibilidad a mayúsculas y orden por fecha. `ENABLE ROW LEVEL SECURITY` y `FORCE ROW LEVEL SECURITY`, política `tenant_id = app.current_tenant_id()`. Cada endpoint además filtra explícitamente **tenant y usuario**: FORCE RLS resuelve empresa, WHERE resuelve propiedad individual, nunca confundir ambas fronteras.

- `GET /api/v1/work-orders/review-queue/views` devuelve **como máximo 10** propias, sin caché compartida.
- `POST .../views` acepta solo `{name,filters}` validados estrictamente. Bloquea la fila de membresía `FOR UPDATE` para serializar dos intentos concurrentes de guardado; rechaza el undécimo con 409 y nombre repetido (case-insensitive) con 409, incluso desde dos pestañas.
- `DELETE .../views/:viewId` elimina solo propiedad del usuario y empresa actuales; devuelve 404 uniforme para un ID que no existe o es de otra identidad.

Entitlement `work_orders`, capability `orders.write`, membresía y rol `tenant_admin/agronomic_coordinator` siguen siendo obligatorios para los tres endpoints. Rutas corren dentro de la transacción que instala el tenant para RLS. SQL usa parámetros, no concatenación de entradas. Los esquemas de filtros rechazan campos nuevos, firmas/cursors, valores fuera del enum, textos no canónicos y modificaciones a roles.

## UX
La banda *Mis vistas guardadas* muestra el nombre de la nueva vista, un guardado explícito, lista de vistas propias, Aplicar vista y Eliminar vista. Eliminar exige **dos pasos**, con Cancelar. Al aplicar se reemplazan los seis criterios y se descartan cursores anteriores: página 1, requestKey nueva, solicitud al backend autorizada y clase actual de estado/revisión calculada de nuevo. No se devuelve un snapshot. La lista se recupera al montar la identidad de la sesión, y la respuesta tardía se cancela con `AbortController` al desmontar. Mensajes con `role=status/alert`, nombres y controles accesibles, foco visible y tamaños táctiles de al menos 44px.

## Gates y aceptación
- Unit backend/frontend: normalización/enum, rechazo de claves desconocidas, cantidad 10, nombres, vista guardada no contiene cursor ni claves de autorización.
- PostgreSQL/PostGIS `*_test`: 201 al guardar y lectura persistente, lectura de otro usuario y otra empresa vacías, borrado de otro usuario 404, rol contratista 403, duplicados 409, undécima vista 409, input inválido 422, FORCE RLS de tabla y backup/restauración.
- Chromium real: guardar combinación de filtros, recargar aplicación y confirmar que reaparece; cambiar filtros, aplicar vista recupera seis valores y reinicia paginación, eliminar solo tras confirmar, botones no guardan resultados ni cursores. Logout/tenant B deja la lista anterior inaccesible.
- Merge solo con ambos jobs `tenant-rls` y `browser-offline` aprobados en HEAD PR exacto y luego CI independiente posmerge SHA exacto. Gates verdes no implican despliegue a VPS/producción, aceptación rural ni pruebas manuales VoiceOver/TalkBack.

## Carriles y rollback
Coordinar reservas y SHA en [#18](https://github.com/FedesConsultora/SedeAgro/issues/18). Otro carril [#105](https://github.com/FedesConsultora/SedeAgro/issues/105) para benchmarks EXPLAIN, sin tocar archivos de estas rutas. [#86](https://github.com/FedesConsultora/SedeAgro/issues/86) sigue con QA de foco. Para rollback, revertir API/frontend antes de retirar migración; `down` rechaza destruir datos de vistas guardadas sin exportación previa.
