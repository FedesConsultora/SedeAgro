# SedeAgro 0.1 — revalidación de sesión cuando otra pestaña cambia la cuenta

**Contexto: 30/10/2026.** El primer cierre de `main` tras el PR #277, SHA `4d96f99a3b5e8f7e4c3847320282670c383f815c`, obtuvo **6/7** en GitHub Actions. El gate `browser-postgis` falló dentro de `scripts/acceptance-browser-evidence-history.mjs`, después de confirmar **multi-tab logout**, al esperar el cartel «No se pudo verificar tu sesión» (línea 284). Ejecución de referencia: https://github.com/FedesConsultora/SedeAgro/actions/runs/41109164302.

## Causa observada

La prueba simulaba una caída de `/auth/me` mediante `page.route(..., { times: 1 })`. Una transición entre pestañas puede generar más de una solicitud de revalidación por las notificaciones de BroadcastChannel, `storage` y/o visibilidad. Si la primera respuesta era 503 y otra solicitud obtenía 200, React podía presentar la sesión **legítimamente revalidada** antes de que Playwright encontrara el cartel transitorio. Por tanto, que el aviso no se observara no demostraba una filtración privada ni una sesión no autorizada: era una ventana no determinista **del escenario de caída parcial del test**.

## Contrato corregido y medible

1. Mantener `GET /auth/me` en **503 para cada petición** del **primer navegador** hasta que aparezca la pantalla bloqueada, en lugar de interceptar un único intento. La segunda pestaña sigue registrando una cuenta real y emitiendo una cookie HttpOnly de Express/PostgreSQL desechable.
2. Confirmar que se recibió al menos un 503 real por el interceptor y que **la vista de evidencia anterior y la navegación privada desaparecieron**. Una respuesta 503, a diferencia de 401, no se debe presentar como cierre confirmado: la pantalla conserva el botón «Reintentar verificación».
3. Remover la intercepción **antes** de pulsar «Reintentar verificación». Esa respuesta posterior debe provenir del servidor real, verificar el cookie de la segunda empresa y mostrar sólo su identidad, no restaurar los documentos del tenant anterior.
4. Conservar todas las demás regresiones: la revocación entre pestañas, volver a la primera cuenta, paginación de evidencias/cursor alterado, modo offline y aislamiento de archivos privados.

La prueba de caída parcial **intencionalmente** genera el 503; nunca fabrica un `/auth/me` exitoso ni sesiones/JWT. No modifica `SessionContext`, el backend, FORCE RLS, permisos ni datos del piloto. En GitHub Actions el job usa PostgreSQL/PostGIS `*_test` descartable; no hay credenciales reales.

**Criterio de cierre técnico:** PR exact-head **5/5 SUCCESS**, seguido de nuevo `main` independiente **7/7 SUCCESS**. El fallo histórico 6/7 permanece registrado; no reetiquetar un test antiguo como aprobado.

**Aceptación externa:** No se probaron navegadores/dispositivos físicos, staging HTTPS ni operación real. La matriz #166 permanece abierta y #130 es **NO-GO**.
