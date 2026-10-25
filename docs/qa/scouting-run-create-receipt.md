# PILOT-SCOUTING-RUN-CREATE-ACK — alta y reintento seguro de recorridas

**Alcance:** frontend de `Nueva recorrida de monitoreo`; backend idempotente integrado en PR #209. Base `main@0f4fefe400f31cabf096ebccf8c0d723906faa48`; coordinación #18, matriz #166, release #130 NO-GO. Sin cambios de JWT, RLS, tablas, cola offline ni infraestructura.

## Contrato actual después de #209

`POST /scouting/runs` acepta opcionalmente `client_request_id: UUID`. Si el **mismo actor autenticado y autorizado** vuelve a enviar la **misma solicitud** con la misma clave dentro del mismo tenant, el backend devuelve el mismo ID y `replayed:true`, sin repetir notificación ni auditoría. Si reutiliza la clave con contenido distinto, devuelve conflicto 409. Las autorizaciones `scouting.plan` y FORCE RLS siguen obligatorias en cada replay; la clave nunca es una credencial.

## Integración de navegador de este bloque

1. El modal exige sesión live autenticada, empresa, usuario, rol tenant_admin o agronomic_coordinator y entitlement scouting. Las opciones se conservan por scope/API y las respuestas tardías de otra sesión no se muestran.
2. Al confirmar el formulario, genera **un UUID criptográfico** con `crypto.randomUUID()` y envía un cuerpo congelado que incluye `client_request_id`. Si el navegador no tiene un generador seguro en el contexto actual, bloquea el alta y muestra un error.
3. Un ticket síncrono antes del primer POST impide doble toque. El ACK sólo es válido si incluye UUID de recorrida, tenant, lote de campaña, responsable, estado, fecha/resumen exactos y un **`replayed` booleano** para solicitudes con clave.
4. Tras un ACK incierto el modal muestra **Reintentar el mismo envío (sin duplicar)**. Esta acción explícita reutiliza el *mismo objeto inmutable con la misma clave y parámetros*. El backend responde con la recorrida original o un conflicto real; nunca se cambia silenciosamente el UUID al reintentar.
5. Una segunda pulsación de reintento queda bloqueada sincrónicamente mientras la primera está pendiente. Si falla de nuevo, se permite otro reintento explícito idéntico. Confirmado ya no se puede enviar de nuevo desde el mismo modal.
6. Cancelar/X/Escape/overlay no cierran el formulario mientras un POST está pendiente; cambio de tenant, usuario, rol o API invalida el ticket anterior y su respuesta tardía. No existe reintento automático.
7. Demo no simula creación.

## Aceptación técnica

`frontend/test/scoutingRunCreateSafety.test.js` comprueba el ticket inicial, retry sólo tras estado incierto, doble retry, descarte de ACK viejos, payload/UUID inmutable, `replayed` explícito y aislamiento de cuenta, además de la validación heredada de recibos y permisos. `backend/test/scoutingRunCreateIdempotency.pg.mjs` (PR #209) ejecutó la idempotencia real en PostgreSQL FORCE RLS para múltiples solicitudes concurrentes, replay, conflicto, tombstones y efectos laterales.

## Aceptación con operador pendiente

- En staging aislado, realizar una recorrida planificada, forzar pérdida del primer ACK **después del COMMIT**, usar el botón explícito de reintento y comprobar exactamente una fila y un solo aviso/auditoría.
- Doble toque en primer POST y en botón de reintento; sólo un request en vuelo por fase.
- Cambiar a otra empresa/actor o revocar rol antes del replay: no recuperar datos ni confirmar una creación no autorizada.
- Probar `client_request_id` con contenido modificado: 409 visible, sin mutar la recorrida anterior.
- Repetir en Android/iOS físicos y con conexión intermitente. **NOT_RUN**.

**Límite de garantía:** el UUID y el cuerpo se guardan sólo **en memoria del modal abierto**, sin tokens en storage. Tras refresh, cerrar pestaña, cambiar dispositivo o cerrar el modal incierto, **NO hay replay recuperable garantizado**: el usuario debe consultar el listado antes de crear otra recorrida. La persistencia segura de clave y cuerpo/fingerprint entre sesiones queda como seguimiento separado en #207. Los tests CI no certifican campo real, staging ni producción. Release #130 sigue NO-GO.
