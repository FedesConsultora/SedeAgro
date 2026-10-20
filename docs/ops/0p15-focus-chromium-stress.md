# 0P.15 — QA repetido de foco real en Chromium y transiciones async

## Motivo

El issue #86 registra un **primer intento FAIL** en aceptación real de un modal al hacer `Shift+Tab`, seguido por una reejecución PASS **sin cambios de código**. No es correcto tomar un rerun como garantía de ausencia de intermitencia. La implementación del trap (`frontend/src/components/Modal.jsx`) ya cuenta con `getDialogFocusable` dinámico; las pruebas anteriores incluían cuatro aperturas/cierres y un `waitForFunction` de foco, con diagnóstico mínimo. No cambiamos la UI ni forzamos foco programáticamente para superar el test.

## Extensión de la aceptación

- El helper `getFocusStressCycles` conserva mínimo cuatro aperturas/cierres en pruebas normales; CI GitHub explícito acepta 4 a 16, sin permitir que un contador menor saltee asserts.
- La suite real `scripts/acceptance-browser-cookie.mjs` ahora ejecuta **12** aperturas/cierres por invocación CI: esperar resolución de la consulta real de productores y formulario habilitado; comprobar foco en raíz de modal, `Shift+Tab` hasta último control **habilitado en el keydown**, `Tab` al primero, `Escape`, cierre y restauración al botón invocador.
- Nuevo caso de intercalación adversaria: Playwright **retiene de verdad** la respuesta HTTP `GET /api/v1/farms/producers`. Mientras la petición permanece en curso `Crear` está deshabilitado, el último tab stop debe ser `Cancelar`; `Shift+Tab`/ `Tab` siguen confinados. Al permitir respuesta real, `Crear` se habilita en React, el foco del control de cierre **no debe saltar de forma inesperada** y un nuevo `Shift+Tab` debe alcanzar el nuevo último elemento habilitado. `Escape` devuelve el foco al invocador.
- Se conserva la prueba separada de error HTTP real 503 y recuperación con `Reintentar`; no se sustituyen datos live por mocks. Las sesiones HttpOnly y RLS siguen con la aceptación integrada previa.
- El workflow de `tenant-rls` corre **dos invocaciones independientes** de la aceptación contra PostGIS real de CI, cada una con un backend y navegador Chromium nuevos (mínimo 24 ciclos de apertura/escape en total más dos transiciones pending→ready); el proceso del servidor y Vite se detiene antes de lanzar el siguiente para evitar falsas interferencias por puertos.
- La instrumentación existente `assertDialogFocus` sigue acotada a 750ms con RAF y recopila solo tags, índices de tab stop y flags booleanos; nunca texto de inputs, IDs, usuarios, contraseñas, HTML ni datos privados. **No hay sleeps** para aceptar un foco erróneo.

## Alcance de la evidencia y cierre

El PR requiere 4/4 jobs green exact-head y **otra corrida push-main independiente**, con salida `FOCUS_STRESS_PASS=1/2` y `2/2` y todos los checkpoints. Si cualquiera falla, mantener #86 abierto; registrar primera falla, no resolver con rerun aislado. El éxito significa mayor confianza de **Chromium Linux** a nivel de CI, no prueba de lector de pantalla, Safari iOS o Android ni certificación de campo.

Ningún script modifica VPS, DB externa, credenciales, migraciones o DOM de producción. Siguen pendientes pruebas físicas, staging aislado, restore privado/rollback y gobierno de GO (#130).
