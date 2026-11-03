# SedeAgro 0.1 — recuperación de cambios de sesión perdidos por una pestaña suspendida

**2026-11-03 · Bloque 0R / integrador.** Basado en `main@65743afa958f32d8359e4daa54bd9c12358923dd` después del cierre de PR #281. Alcance limitado a la capa de sesión browser y a su aceptación, sin modificar cookies HttpOnly ni autorización backend.

## Riesgo y resultado funcional

El esquema anterior avisaba a otras pestañas por BroadcastChannel y un `localStorage` *transitorio*: `sedeagro.auth-transition-v1` se escribía y borraba inmediatamente. Un navegador suspendido o un tab background podía perder **ambos** eventos. Su comprobación por foco, limitada a una vez cada 60 segundos, no reaccionaba enseguida si otro tab ya había cambiado la cookie y además eliminaba el tenant hint tras logout. Mientras tanto, React podía mantener la vista antigua hasta una acción posterior.

Se conserva la señal temporal para compatibilidad con versiones abiertas y se agrega el **witness opaco** `sedeagro.auth-transition-witness-v1`. Cada login/logout confirmado escribe solamente `{kind:'session-transition',source:UUID,nonce:UUID}`; no contiene empresa, usuario, rol, cookie, JWT, sesión, evidencias, GPS, nombres, claves ni cuerpos de solicitud. Se valida esquema estricto antes de consumirlo. **Es un aviso no confiable**: nunca concede acceso, nunca restaura una sesión por sí solo y puede provocar una revalidación como mucho.

Al montar una nueva pestaña se toma como conocido el marcador previo, porque la aplicación ya consulta `/auth/me` desde cero. Cuando una pestaña vuelve al frente, `catchUp()` compara el último witness con los eventos observados. Si hubo una transición nueva y se perdió su notificación, **primero pone en cuarentena los datos privados** y después busca autoridad en el backend, **saltándose el período de 60 segundos**. Esto ocurre también si el `tenantHint` desapareció: el hint es sólo de navegación, no credencial.

También se valida la secuencia de cada `/auth/me` frente al witness y al tenantHint **antes** de aceptar tanto un 200 como un 401/403/404. Un GET de un tenant anterior que llega después de un cambio de cookie/hint no puede restaurar la identidad vieja ni borrar el hint del tenant nuevo. La respuesta antigua se descarta y se vuelve a validar con la autoridad y el hint actuales. La ausencia de localStorage o de BroadcastChannel no genera una autenticación ficticia: se conserva el fallback de revalidación por foco, y el backend mantiene las reglas originales de membresía/entitlement.

## Cobertura automatizada

- **Unit** `frontend/test/sessionTabSync.test.js`: canal + storage sin duplicación, formato opaco sin secretos, dos señales perdidas durante suspensión sin BroadcastChannel, catch-up único en primer foco, nuevo tab sin replay anterior, storage malformado y acceso denegado; respeta throttle del fallback.
- **Wiring** `frontend/test/sessionTabWiring.test.js`: orden obligatorio witness → cuarentena → `/auth/me`, comprobación del hint antes de aplicar 200/401, ningún acceso a IndexedDB privado dentro de señales de autenticación.
- **E2E** `scripts/acceptance-browser-evidence-history.mjs`: bajo Playwright/Chromium con cookies reales, Express y base PostgreSQL/PostGIS `*_test`, una pestaña carga evidencias privadas del tenant A. A esta pestaña se le suprimen deliberadamente BroadcastChannel y eventos `storage` (para emular suspensión). La pestaña activa cierra sesión realmente, inicia sesión con tenant B real, actualiza el witness sin datos de cuenta. Al enfocar la pestaña suspendida, `GET /auth/me` se retrasa pero NO se suplanta: se comprueba que la evidencia y navegación del tenant A estén ocultas antes de resolver la respuesta y, al continuar, que solamente se adopte B por respuesta real del servidor. Luego se vuelve al tenant A y se conserva la regresión de revocación de sesión real en PostgreSQL.
- Las pruebas existentes de reconexión offline GPS/fotografía, aislamiento de evidencias, cola cifrada y RLS siguen intactas.

## Límites y rollback

- El witness persistente **no es una prueba de autenticación** ni garantiza eventos en equipos/OS que no activan ningún evento `focus`/visibilidad. El frontend debe verificar la cookie mediante `/auth/me`; si la red está caída, los datos privados continúan ocultos mientras se ofrece reintentar.
- No guarda PII ni secretos, pero un script de mismo origen puede provocar un recheck espurio escribiendo una señal válida: denegación de disponibilidad potencial, **no elevación de permisos**. XSS se trata aparte.
- El marcador puede permanecer en el almacenamiento del origen después de cerrar sesión, y no debe interpretarse como permiso para recuperar datos. Se conserva el `SESSION_TAB_KEY` temporal para interoperabilidad con pestañas anteriores.
- Rollback frontend no requiere migración ni borrar claves de IndexedDB. La key witness es sólo texto no sensible y puede ignorarse por una versión anterior; el mecanismo de revalidación anterior sigue operativo.
- Sin cambios en endpoints, backend, tablas/RLS, migraciones, queue offline, vault, SessionExpiry, workflows, VPS, staging o producción. Sin aceptación física Android/iOS, QA de dispositivo o firma Product/Security. **Release issue #130: NO-GO**.
