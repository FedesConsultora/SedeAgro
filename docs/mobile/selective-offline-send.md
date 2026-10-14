# 0S.9 — Enviar una sola captura offline

En **Sincronizaciones**, cada observación local sin confirmación tiene su propia acción **Enviar solo esta**. Si presenta un conflicto o perdió autorización, se ofrece **Reintentar solo esta**, con confirmación explícita antes de volver a consultar al servidor. Funciona también cuando la pantalla está filtrada por una recorrida desde Monitoreo.

## Qué envía realmente

El envío individual lee el registro **actual** de IndexedDB cifrado, dentro del **mismo bloqueo por cuenta/empresa** que utiliza el envío automático y el envío general. Se valida que el identificador pertenezca al usuario y tenant de sesión, que conserve su clave de idempotencia, que se trate de **una operación create de observación** y que su `scouting_run_id` coincida exactamente con la recorrida registrada. Solo ese cuerpo original se envía al `POST /sync/batches`.

La función `flushOne(session, id, send, {sendEvidence})` comparte la implementación de `flush`, incluyendo:
- protección contra envíos simultáneos en la misma pestaña (`inFlightScopes`) y bloqueo entre pestañas (`navigator.locks` cuando existe);
- claves idempotentes persistentes, respuesta `processed` y operación `applied` antes de retirar una copia local;
- envío de fotografía original, si existe, seguido de confirmación independiente de su carga;
- retención del borrador y backoff ante pérdida de conexión/respuesta, 401, 403, 409 y errores de servidor;
- sin duplicar ni reescribir una foto cuyo `syncedObservationId` ya esté confirmado: el caso foto-only se resuelve en **Conciliar observaciones** mediante el bloque 0S.6.

El envío general **Enviar pendientes / Enviar todos mis pendientes** no cambia. Sigue recorriendo todas las capturas elegibles de la cuenta. Si la pantalla está enfocada en una recorrida, continúa exigiendo confirmación para advertir que se enviarán también otras. El envío individual, en cambio, solo abre **una** entrada y nunca itera la cola de otras recorridas.

## Seguridad y alcance

No se añade almacenamiento en claro ni se imprimen coordenadas, notas privadas, contenidos de fotografía, tokens o identificadores completos en la UI. Un UUID inválido o de otro scope, borrador corrupto o recorrido incompatible se rechaza **antes del HTTP**. Si la misma cuenta está sincronizando en otra pestaña, la operación individual devuelve `skipped` y no se afirma que el servidor haya recibido nada.

**La operación manual no obliga al backend a aceptar una recorrida cerrada, revocada o ajena:** los permisos, tenant y estado siguen siendo controlados por el servidor. Tampoco modifica historial de recibos, roles o estado remoto.

## Verificación

```bash
npm --workspace frontend run test
npm --workspace frontend run build
```

GitHub Actions ejecuta pruebas de frontend/backend, Chromium real con IndexedDB en modo offline, PostgreSQL/PostGIS/RLS y build. El merge requiere ambos jobs `tenant-rls` y `browser-offline` aprobados sobre el HEAD exacto.

Probar físicamente antes del piloto: dos recorridas con pendientes, enviar la de una sin tocar la otra, error 409/401, pérdida de ACK después de commit, dos pestañas simultáneas, fotografía ya sincronizada parcialmente y reconexión móvil. No hay despliegue a producción en este bloque.
