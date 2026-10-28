# Piloto 0.1 — Equipos operativos reales (#253)

## Diagnóstico del código base (27 de octubre de 2026)

El módulo `Equipo` mostraba equipos y miembros en modo live, pero sólo ofrecía la creación de *usuarios* mediante invitación y una simulación de invitación en demo; no tenía acción live para crear un equipo operativo o agregar integrantes. El backend **ya ofrecía** `POST /teams` y `POST /teams/:id/members`, con tests reales PostGIS en `teamFarmCreation.pg.mjs` y `teamMemberLifecycle.pg.mjs`: validación de miembros activos, empresa ajena, rol denegado, creación/reenvío idempotente y conflicto ante reasignación. Este PR no introduce nuevos endpoints ni migraciones.

## Experiencia entregada

En `Equipo`, el administrador de empresa o coordinador agronómico con `org` y sesión live puede:

1. Crear un equipo de alcance operaciones, agronomía, contratistas, clientes o soporte con nombre obligatorio de 2–160 caracteres. Los nuevos equipos no se asocian a un establecimiento en este primer control; la API de backend conserva ese soporte.
2. Seleccionar un equipo y sumar una membresía actualmente activa con función operativa propia (2–80 caracteres). La lista de candidatos excluye, en la UI, usuarios globalmente deshabilitados, membresías suspendidas e integrantes ya añadidos. El servidor comprueba cada condición de nuevo bajo RLS antes del COMMIT.
3. Obtener confirmación solamente cuando el servidor responde con IDs de equipo, integrante, tenant y datos esperados. Cada éxito actualiza los listados reales desde backend. Ante timeout/ACK ambiguo informa que debe revisarse el listado antes de reintentar. Los endpoints existentes reconocen replays idénticos y rechazan cambios de configuración mediante 409.
4. Mantener datos de otra empresa o sesión fuera de pantalla incluso si llega una respuesta tardía; la operación se liga al snapshot de autoridad y de instancia API. Hay bloqueo síncrono de doble submit. Demo no escribe datos reales.

**Permisos:** los botones son una protección de experiencia, no una fuente de autorización. La API sigue imponiendo `teams.write` y el acceso a miembros activos; el rol `scout`, contratista o productor no puede mutar equipos. Las etiquetas de función del equipo no elevan roles RBAC. Se mantienen todos los flujos actuales de invitación, suspensión y reactivación de membresías.

**Privacidad:** `GET /teams` devuelve nombres y correos de miembros activos, por lo que ahora marca `Cache-Control: private, no-store`. La prueba HTTP existente de `teamMemberLifecycle.pg.mjs` comprueba el header con servidor real.

## Aceptación y límites

- `frontend/test/teamOperationsSafety.test.js` comprueba los permisos de UI, validación de campos, rechazos de acuses de otra empresa/equipo/usuario, miembros suspendidos y control de respuestas tardías.
- `backend/test/teamMemberLifecycle.pg.mjs` mantiene el recorrido PostgreSQL multiempresa (activos, bloqueados, replays, 403/404/409/422); agrega aserción real de encabezado anti-caché. No se duplican pruebas existentes.
- Antes del merge: GitHub CI exact HEAD 4/4; después: CI independiente main 6/6.
- **Faltan** staging autorizada y prueba física por actor: crear equipo, aceptar invitación, incorporar scout, suspender membresía, comprobar invisibilidad e imposibilidad de modificación desde sesión vieja, dos empresas, recuperación tras ACK perdido. No reclamar PASS de dispositivos ni corrección de memberships RLS (#232).
- Continuidad offline tras cierre de navegador (#163) y auditoría de seguridad/release (#130) siguen **NO-GO**; no hubo deploy ni acceso a sistemas productivos.
