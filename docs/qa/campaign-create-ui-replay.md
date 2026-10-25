# Piloto — Reintento explícito de creación de campaña sin duplicar

**PR apilado sobre backend #224:** no habilitar este frontend hasta que el API pueda aceptar `client_request_id` y emitir `replayed:boolean`. Cadena de aceptación #166, coordinación #18, release #130 NO-GO.

## Antes

El formulario de campaña protegido por #208 impedía dobles pulsaciones de un POST en una apertura, pero tras una respuesta HTTP perdida dejaba la operación bloqueada y obligaba a inspeccionar el listado. Como el backend no tenía recibo persistente, no existía una manera segura de recuperar por la misma clave el UUID original.

## Contrato de este bloque

1. Al enviar una campaña live, valida fechas, rol, tenant, límites de texto y entitlement antes de emitir POST.
2. Si el navegador soporta `crypto.randomUUID()` bajo contexto seguro (HTTPS/localhost), asigna un UUID de creación y captura **una única vez** el payload validado + la clave en un objeto congelado, vinculado a la empresa/actor/membresía/rol y objeto API de ese momento.
3. `POST /campaigns` acepta la clave opcional; el backend #224 compara un SHA-256 del cuerpo y lo asocia al actor bajo FORCE RLS.
4. La respuesta de un POST con clave sólo da éxito si se valida tenant, UUID, nombre, año, fechas, estado **y `replayed` booleano**. Un HTTP 200/201 sin ese contrato queda como incierto, nunca como alta exitosa.
5. Ante pérdida de ACK, el modal ofrece **Reintentar el mismo envío**. Sólo la acción explícita del operador permite repetir el mismo objeto inmutable con idéntico UUID, fechas, campaña y estado. Un ticket síncrono bloquea doble toque y segundo reintento concurrente.
6. Cancelar, X, Escape y overlay no cierran el modal con POST pendiente. Una respuesta que llegue de otra sesión/empresa/API es ignorada; la cuenta anterior no puede confirmar el formulario nuevo.
7. Sin WebCrypto UUID seguro no se despacha el POST. El modo demo no guarda campañas reales ni simula un ACK del backend.

## Pruebas

`frontend/test/campaignCreateSafety.test.js` incluye regresiones para recibo key+replayed, ausencia/tipos incorrectos del indicador, actor/scope, payload congelado, idempotent retry, doble reintento, descartes de tickets obsoletos y wiring del modal. Es obligatorio ejecutar el PR sobre base backend #224 y pasar los cuatro controles de seguridad, build, navegador y PostgreSQL.

## Aceptación de operador pendiente

En staging autorizado y navegador físico Android/iOS, crear campaña, forzar timeout **después de COMMIT**, reintentar desde el mismo formulario con la misma clave y comprobar una única fila en DB y mismo ID. Cambiar actor/empresa entre ambas peticiones debe rechazar/acotar el reintento. No confundir fallo de validación o conflicto 409 con una confirmación exitosa.

**Limitación explícita:** clave + payload se guardan sólo en memoria del modal abierto. Después de recarga, cierre de pestaña/navegador o cambio de dispositivo, el usuario debe revisar el listado antes de una nueva creación. La recuperación segura cross-refresh requiere otro PR con diseño de almacenamiento local y autorización, y no se promete aquí. Ni CI verde ni esta implementación constituyen aceptación de campo, release ni certificación offline. P0 #222 usuarios/roles y P1 #163 MOB-05 siguen abiertos.
