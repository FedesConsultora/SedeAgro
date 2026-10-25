# Piloto 0.1 — Privacidad de listados de Equipo al cambiar empresa

**Base:** `main@1224b938349da4e332757e9fcca3a1acea3e39b1`. Coordinación #18, aceptación #166, release #130 NO-GO. No se cambia el contrato backend ni se habilitan invitaciones live.

## Defecto de código observado

`TeamPage` almacenaba arrays de miembros y equipos en estado de componente y los borraba sólo al iniciarse `useEffect` tras el cambio de sesión/API. Entre render y efecto podía aparecer la lista privada del tenant anterior. Una respuesta GET retrasada también podía llegar entre cambios de cuenta. Para aceptar el primer piloto con múltiples empresas, los nombres y emails de otro actor no deben aparecer ni brevemente.

## Defensa aplicada

- `teamPrivateListScope` exige identidad live autenticada, tenant, actor, membresía y entitlement `org`; incluye rol y módulos para detectar cambios. El modo demo tiene un scope separado y **no es autoridad para datos reales**.
- Ambas listas se presentan exclusivamente desde un snapshot cuyo **scope y objeto API** coincidan con la identidad actual durante ese mismo render. Si el usuario/tenant/rol cambia, se muestran listas vacías y estado de carga/rechazo hasta la consulta nueva, sin esperar un efecto.
- Cada petición de `members()` y `teams()` captura la identidad que la inició y sólo puede escribir resultados si sigue activa y el scope/API coinciden. Los fallos de una colección no contaminan a la otra, y las respuestas inconsistentes son descartadas por `checkedTeamPrivateRows`, que rechaza un `tenant_id` ajeno cuando está presente.
- Las listas mock se conservan sólo en el scope demo. El botón «Simular invitación» permanece exclusivamente en demo; las invitaciones live siguen **NO_IMPLEMENTADAS**.
- El servidor continúa imponiendo `members.read` y `teams.read`, RLS y permisos, que no pueden sustituirse con esta protección UI.

## Tests y aceptación

`frontend/test/teamPrivateListScope.test.js` comprueba cambios de tenant, usuario, membresía, rol y entitlement, no mezcla entre demo y live, respuesta con tenant ajeno, formatos inválidos, binding de render y request abort lógico. El CI exact-head debe cubrir Node frontend, PostgreSQL/FORCE RLS, Chromium y seguridad.

**Escenarios reales pendiente (NOT_RUN):** abrir Equipo con tenant A, cambiar a B mientras las peticiones GET están pendientes; comprobar que nunca se muestran nombres ni correos del actor anterior. Repetir cambiando roles, revocando entitlements, cerrando sesión y desde dos pestañas; verificar 403, 401 y desactivación de cookies en staging y Android/iOS. Si la sesión no está autenticada la página no solicita datos privados.

**Bloqueo independiente:** issue #222 documenta que la UI live no puede invitar usuarios nuevos; este PR no debe presentarse como solución de incorporación de usuarios. Issue #163 cold start offline también permanece sin solución, y #130 sigue NO-GO.
