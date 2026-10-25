# PILOT-CAMPAIGN-CREATE-ACK — alta segura de campañas

**Ámbito:** \`Nueva campaña\`, contexto live, sin cambiar la API pública, migraciones, rol/RLS, staging, offline ni producción. Base original \`main@6a5ade8dae88376aeee2e2f002d266d29afe29f4\`. Coordinación #18, matriz de aceptación #166 y salida #130 **NO-GO**.

## Problema verificado en código

\`CampaignFormModal\` permitía doble \`POST /campaigns\` si dos submits ocurrían antes de que React confirmara \`saving\`. Tras una promesa 2xx ejecutaba \`onCreated()\` sin verificar que el servidor devolviese la misma campaña (tenant, fechas, año, nombre y estado). El formulario podía mandar \`ends_at: ''\` aunque el backend valida una fecha opcional con Zod, y no evitaba previamente un período invertido o una fecha imposible. En modo demo activaba el callback de creación sin persistencia real.

## Implementación

1. \`campaignCreateScope\` exige sesión live autenticada y tenant, usuario, membresía, rol de planificación (tenant_admin o agronomic_coordinator) y entitlement campaigns. Es un cerco de UI: el backend conserva \`campaigns.write\` + autorización por tenant/RLS.
2. \`prepareCampaignCreate\` normaliza nombre y año, valida fecha DATEONLY gregoriana estricta y que fin sea mayor o igual a inicio; omite \`ends_at\` vacío para no enviar una cadena no válida. No transforma el día local a instante UTC ni inventa fechas.
3. Se adquiere un ticket síncrono antes del primer \`await createCampaign\`. Un doble click/tap no puede despachar un segundo POST de esta apertura. Confirmado o incierto queda bloqueado hasta cerrar y volver a abrir.
4. \`verifyCreatedCampaign\` exige UUID válido, tenant exacto, nombre, temporada, fechas y estado en el acuse del servidor. Un HTTP 2xx malformado/cambiado no marca éxito.
5. Tras un POST despachado cuyo acuse se pierde, no hay retry automático: se solicita cerrar el formulario y comprobar la lista de Campañas antes de intentar de nuevo. Modal no puede cerrarse con X/Escape/click fuera mientras hay solicitud pendiente.
6. El texto introducido queda marcado con scope+API. Cambio de empresa, usuario, rol, membresía o permiso lo oculta en render antes de ejecutar efectos; las respuestas tardías no completan otra sesión.
7. Modo demo muestra un aviso y no simula persistencia.

## Pruebas automatizadas

\`frontend/test/campaignCreateSafety.test.js\` cubre cambios de scope/rol/tenant/actor/membresía/permisos, comprobación de fechas y años, omisión de fecha final opcional, fechas imposibles, período invertido, acuses equivocados, doble POST asíncrono, resultado incierto y descarte de tickets antiguos. Inspección del wiring del formulario.

## Aceptación en staging y móvil — aún NO EJECUTADA

- Con administrador y coordinador del tenant A, crear una campaña con fecha final; comprobar en GET/backend PostgreSQL su UUID, fechas DATEONLY, nombre, año y estado. Crear otra planificada sin fecha final.
- Simular dos toques rápidos y una pérdida de ACK después del COMMIT; inspeccionar que el modal envíe una vez, que una respuesta incompleta no cierre y que el operador vea el aviso de revisión.
- Cambiar a tenant B/rol scout durante respuesta HTTP. No mostrar el nombre privado anterior ni confirmar nada de la cuenta A. Prueba directa del backend devuelve 403/404 según permiso/tenant.
- Probar \`2027-02-29\`, \`2028-02-29\`, período invertido y fecha final vacía. La validación es previa a la red.
- Repetir en navegador móvil real (Android/iOS), no dar por aprobada esa aceptación por Chromium CI.

**Límite de garantía:** \`POST /campaigns\` sigue sin client-request UUID persistente; un refresh, otra pestaña o dispositivo puede duplicar una campaña legítima. El bloqueo es sólo por apertura de modal, no exactly-once servidor. No ampliar con migración/índice único por nombre porque dos campañas con nombre igual pueden ser legítimas. No tocar #163 ni #130 sin autorización.
