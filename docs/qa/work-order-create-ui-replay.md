# Piloto — Reintento seguro al crear una orden de trabajo

**Dependencia:** backend PR #226 (`POST /work-orders` con `client_request_id` opcional y recibo `replayed`). Este frontend está en PR apilado y **no puede fusionarse antes del backend**. Matriz #166, coordinación #18, release #130 NO-GO.

## Funcionamiento

- Sólo un administrador o coordinador autenticado con permiso de órdenes y empresa activa puede crear una orden live; el backend sigue verificando `orders.write` + FORCE RLS. Los lotes disponibles provienen del backend y no de una lista demo en modo live.
- Antes del primer POST, el cliente valida el lote, título y hora límite. Convierte `datetime-local` a un instante ISO, para que el mismo timestamp se conserve en reintentos sin interpretarlo en otra zona horaria.
- En contexto web seguro crea `crypto.randomUUID()`, toma un snapshot congelado de los datos de orden y lo envía con `client_request_id`. El ticket síncrono bloquea doble toque antes del próximo render.
- Para confirmar una respuesta key-based se exige UUID de orden, actor `requested_by`, tenant exacto, lote, asociación de campaña opcional, tipo, título, prioridad, estado draft, instrucciones, fecha y un `replayed` booleano. Un 2xx de contenido distinto **no es éxito**.
- Si se perdió el ACK después de COMMIT, aparece «Reintentar el mismo envío». El reintento voluntario toma **el mismo objeto inmutable y UUID**, sin reconstruir los valores del formulario. Otro clic simultáneo se bloquea. Un resultado inconcluso puede reintentarse otra vez con la misma clave, sin reenvío automático.
- Una API o sesión de otra empresa no puede completar la operación anterior ni habilitar datos de ese contexto. Escape, X, overlay y Cancelar no cierran mientras el POST está pendiente.
- No se guardan ni token, ni UUID, ni payload en LocalStorage/SessionStorage. Demo sigue siendo simulación explícita, sin afirmar una operación real.

## Pruebas y límites

El test `frontend/test/workOrderCreateSafety.test.js` mantiene los casos existentes y añade receipt exacto y `replayed`, tenant ajeno, orden con contenido alterado, gate de retry sólo desde resultado incierto, doble retry y vinculación del modal con el mismo payload. El backend PR #226 prueba PostgreSQL nonowner FORCE RLS, carreras y revocación reales.

Para aceptación de operador: crear orden, simular timeout tras COMMIT, pulsar «Reintentar el mismo envío» y comprobar una sola fila y mismo UUID; cambiar actor/empresa antes de respuesta debe dejar de confirmar; probar 409 con la misma clave y otro body, y 401 tras revocación. Android/iOS + staging **NOT_RUN**.

**Límite importante:** la clave sólo persiste en memoria del modal abierto. Si la pestaña se cierra o recarga, el usuario debe revisar el listado antes de crear otra orden. No se afirma garantía cross-refresh/cross-device ni exactly-once para las rutas que no envían clave. Una solución offline requeriría recuperación cifrada y desbloqueo local seguro, relacionada con MOB-05 #163. No desplegar ni declarar GO de #130.
