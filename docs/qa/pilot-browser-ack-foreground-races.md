# SedeAgro 0.1 · Gates Chromium: transición foreground y revisión sin ACK

**2026-11-03 · Bloque 0R/Integrador · #18/#130 · Base main `1bc09cec984e3f3bb756d3ff020152241358ca29`.**

## Evidencia y problema

La CI de `main` posterior a PR #285, [run 41656752657](https://github.com/FedesConsultora/SedeAgro/actions/runs/41656752657), terminó **6/7 en dos intentos** sobre el mismo SHA:

- **Intento 1:** `scripts/acceptance-browser-evidence-history.mjs:278`, expiró `page.waitForResponse` a los 14 s esperando una respuesta `/auth/me` 503 durante cambio real de cookie a otra empresa. La primera pestaña había quedado en background; el test dependía de que el aviso entre pestañas disparara una comprobación por sí mismo, cuando la implementación también admite recuperar una transición omitida **al ganar foco**.
- **Intento 2:** el escenario de sesiones/foreground sí pasó, pero `scripts/acceptance-browser-review-inbox.mjs:926` falló con `route.abort: Route is already handled!`. El test había ejecutado `route.fetch()` (POST real), consumido la respuesta y, después, pedido `route.abort()` sobre la misma ruta de Playwright. El browser podía cancelar/manejar esa ruta en medio de la espera. El fallo no prueba una repetición del commit SQL.

Ambos errores son **intermitencias de la aceptación** observadas en CI, no se atribuyen a PostgreSQL/RLS sin evidencia. Este bloque no autoriza desplegar SedeAgro 0.1.

## Corrección A: cambio de empresa y pestaña inactiva

Tras registrar el tenant B y colocar la cookie real en la pestaña activa, la prueba **vuelve expresamente al tab A y dispara un evento de foco**. El productor del witness opaco y la revalidación `/auth/me` siguen siendo el código real; la prueba no escribe el witness ni fabrica autoridad. La ruta interceptora 503 permanece bloqueando **todas** las revalidaciones hasta que se vea la cuarentena: sin panel de evidencias, sin navegación privada y sin declarar logout confirmado. Después se libera el 503 y el botón de reintento obtiene el `/auth/me` auténtico de Express; se exige que el usuario y tenant cambien por sesión real.

La prueba separada de **tab suspendida sin BroadcastChannel ni eventos storage** permanece intacta y vuelve a comprobar que el witness opaco recupera el cambio al enfocar.

## Corrección B: incertidumbre de revisión después de un POST real

Para simular la confirmación HTTP perdida sin `route.fetch() → route.abort()` sobre el mismo objeto:

1. Interceptar exactamente el **único POST original del navegador** y capturar sus bytes JSON/UUID (solo en memoria de test).
2. **Abortar inmediatamente la ruta del navegador** con `failed`, de modo que React **no recibe ningún HTTP 200** de confirmación ni una respuesta sintética exitosa.
3. Desde el contexto de peticiones de prueba **asociado a ese mismo BrowserContext**, enviar **una sola copia de los bytes originales** a la URL original de Express. El contexto comparte la cookie **HttpOnly auténtica** de la sesión, y se incluyen los encabezados de pertenencia al tenant y protección de escritura que usa la app. La copia corre en el *test harness*, nunca en el runtime. Si la solicitud devuelve un error o no confirma `replayed:false`, el test falla, no supone commit.
4. Bloquear solamente el primer GET de reconciliación con el 503 temporal preexistente. La UI debe conservar el recibo AES-GCM en IndexedDB, **no auto-reintentar el POST**; luego de recarga, GET real autorizado confirma el reporte exacto y la limpieza transaccional de la fila.
5. Las verificaciones SQL existentes exigen una sola revisión, **un evento de auditoría y un recibo** de idempotencia para el UUID original; el segundo escenario de POST nunca entregado sigue requiriendo el reintento manual del mismo cuerpo.

**Matiz de simulación:** en esta prueba se aborta el POST del navegador *antes* del envío espejo desde APIRequestContext. No se afirma que el mismo socket de browser haya entregado bytes a Express antes de abortar; sí se verifica el estado difícil y relevante de negocio: el cliente vio error, el backend realmente confirmó la decisión una vez, y la recuperación ocurre por un GET autorizado. Nunca se finge un 200 ni se modifica el backend.

## Alcance, pruebas y seguridad

- Solo scripts de aceptación, prueba de regresión estructural `frontend/test/pilotBrowserAcceptanceRaces.test.js` y este documento. Sin modificaciones a auth, permisos, RLS, migraciones, datos cifrados, React de producción, workflows ni configuración de staging.
- Las credenciales de prueba/cookies son administradas por Playwright y la sesión real; nunca se registran, interpolan en logs, persisten ni se envían a otros servicios. Las validaciones de tenant, UUID, reporte y auditoría no se saltean.
- La prueba estática evita regresar a `route.fetch() → route.abort()` y obliga a ejecutar la transición foreground antes de esperar el 503. No reemplaza los gates de Chromium + Express + PostGIS.
- Requerir **CI exact-head de PR (5/5)** y **CI independiente de `main` (7/7)** antes de dar cerrado el problema. No aceptar como diagnóstico suficiente una sucesión de reruns verdes/rojos; si aparece una falla nueva, conservar logs de todos los intentos.
- Rollback simple de scripts/test/docs. No borrar IndexedDB persistente ni datos reales.
- **#130 sigue NO-GO:** staging, aceptación de campo en Android/iOS y firmas Security/Product continúan pendientes.
