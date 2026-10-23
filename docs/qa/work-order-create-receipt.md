# PILOT-ORDER-CREATE — creación de órdenes sin doble envío ni acuse falso

## Brecha encontrada en el código del piloto
Antes de este bloque `WorkOrderFormModal` utilizaba únicamente `setSaving(true)` para impedir otros envíos. React puede recibir dos eventos de submit antes del siguiente render y `POST /work-orders` inserta una orden nueva en cada llamada. Además, después de `await api.createWorkOrder(body)` la UI llamaba `onCreated()` sin exigir que el servidor devolviese la misma orden, y mantenía la selección de lotes en estado local incluso mientras cambiaba la cuenta o el rol.

**Importante:** el POST actual no tiene un identificador idempotente proporcionado por el cliente. Un timeout o ACK perdido después del COMMIT deja resultado ambiguo: el navegador no puede confirmar que la base no creó la orden. Evitar dobles toques no garantiza idempotencia frente a reinicios o intentos deliberados desde otra pestaña.

## Contrato implementado

- `workOrderCreateScope` sólo autoriza la interfaz live para sesiones autenticadas con rol `tenant_admin` o `agronomic_coordinator` y derecho `work_orders`. La clave incluye tenant/usuario, rol y todos los entitlements normalizados; no equivale a la autoridad del servidor.
- El formulario muestra lotes únicamente desde un snapshot etiquetado con esa clave y referencia al API actual. Un resultado del fetch de la cuenta anterior no se muestra ni puede seleccionarse antes de ejecutar el cleanup de React.
- `createWorkOrderSubmitGate` adquiere un ticket **síncronamente** antes del primer await. Un segundo toque no inicia otro POST. El botón y los campos permanecen bloqueados durante la petición.
- `verifyCreatedWorkOrder` exige UUID real, `requested_by`, `field_id`, `type`, `priority`, `title` y `status=draft` idénticos a la solicitud antes de llamar `onCreated`. No supone que un HTTP 2xx baste para confirmar persistencia.
- Ante una petición ya enviada cuya respuesta sea incompleta o cuya red falle, el formulario permanece en **confirmación pendiente**, sin reintento automático ni segundo POST en ese modal. El operador debe cerrarlo, actualizar Órdenes y verificar si la orden existe antes de intentar una nueva.
- El cierre por botón, clic fuera o Escape se bloquea **durante** el POST; después de un resultado ambiguo puede cerrarse para consultar la lista. Un callback viejo de otra sesión no puede mostrar éxito ni desbloquear el ticket nuevo. En modo demo no se transmite al backend.

## Regresiones y aceptación

El test puro `frontend/test/workOrderCreateSafety.test.js` cubre: doble tap concurrente con una sola escritura; bloqueo después de éxito y ACK ambiguo; liberación sólo por preflight o reapertura; resultado tardío de sesión anterior; denegación al cambiar permisos o cuenta; rechazo de UUID de orden inválido y acuses con autor, lote, tipo, prioridad, título o estado equivocados; y cableado estático del formulario.

En staging privado autorizado, ensayar:
1. Dos toques rápidos en Crear orden con conexión lenta: exactamente **una** fila y una sola orden listada.
2. Cortar red luego de commit pero antes del acuse: no permitir reenviar desde el mismo modal; al refrescar la lista se muestra la orden persistida.
3. Cambiar de tenant, rol o permisos durante `GET /fields` o POST: no presentar lotes anteriores ni éxito tardío.
4. Cerrar con Escape/overlay mientras el POST está pendiente: el modal debe permanecer abierto. Tras respuesta ambigua debe poder cerrarse.
5. Probar usuario sin `orders.write` y un lote ajeno: el servidor sigue respondiendo 403/404 bajo FORCE RLS.

El cliente **no agrega idempotencia persistente** al endpoint: recuperar un envío ambiguo entre sesiones requeriría un contrato servidor con clave estable, migración y prueba multi-worker. No se inventa ese comportamiento ni se modifica el esquema. Android/iOS físicos, staging, DR y aprobación de release siguen NOT_RUN/NO-GO. Issues #163 y #130 no están resueltos por este bloque.
