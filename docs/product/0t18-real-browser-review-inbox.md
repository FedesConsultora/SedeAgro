# 0T.18 — Aceptación Chromium de la bandeja de coordinación (React + Express + PostgreSQL reales)

## Evidencia de origen y objetivo

En el `main` exacto `267b843e0e9bde3233bd91f194766afc32f1b11e`, 0T.15–0T.17 ya integraron paginación mediante cursor HMAC asociado al usuario/tenant, reinicio ante `422 ORDER_REVIEW_CURSOR_INVALID`, carga sin resultados obsoletos, interrupción de peticiones y foco accesible. Las pruebas unitarias existentes validaban políticas y cableado, pero **no ejecutaban el recorrido completo desde Chromium real con React/Express/PostGIS**. El script existente `acceptance-browser-cookie.mjs` comprobaba sesión/otros formularios, no la bandeja; `acceptance-browser-evidence-history.mjs` cubría evidencias de recorridas, no órdenes.

Este bloque agrega **una prueba E2E ejecutable**, no un nuevo flujo de producto ni otra API. No modifica autorización, RLS, contratos de partes, inventario o datos productivos.

## Script nuevo y gate obligatorio

`scripts/acceptance-browser-review-inbox.mjs` se ejecuta en `.github/workflows/postgres-isolation.yml` **en cada PR y push a main**, después de las migraciones, roles de mínima autoridad, PostgreSQL/PostGIS, restauración y gates existentes de cookie/evidencias.

El script se niega a arrancar salvo que **ambas** URLs (propietario y runtime) apunten a bases cuyo nombre contiene `_test`/`-test`. Arranca Express con rol runtime RLS, Vite y Chromium con puertos loopback, registra una empresa real mediante UI y autentica por cookie HttpOnly. Activa el entitlement `work_orders` únicamente en la base descartable y crea un establecimiento, lote y **61 órdenes de prueba** en esa empresa mediante SQL. Al terminar cierra navegador/procesos y elimina empresas y usuarios de ensayo. No se inicia ningún deploy ni servidor de producción.

## Recorridos y condiciones de aceptación

1. **Datos reales:** la bandeja autenticada muestra 50 órdenes reales en la primera página, sin usar `route.fulfill` para forjar una respuesta 200, sin marcador de demostración ni exponer notas o detalles de otro tenant.
2. **Teclado, paginación y lectura pendiente:** Enter en «Página siguiente» inicia una solicitud. El navegador retrasa una **respuesta 200 que realmente provino de Express**; durante esa espera comprueba `aria-busy`/estado de carga y que **no queden los 50 registros anteriores** aparentando ser la nueva página. Al liberar la respuesta muestra las 11 órdenes restantes, foco en el título y Next deshabilitado; Enter en Anterior devuelve a la primera y vuelve a posicionar foco.
3. **Cursor firmado alterado:** Chromium modifica solo el parámetro de la solicitud saliente de la segunda página. **Express real** devuelve `422 ORDER_REVIEW_CURSOR_INVALID`; se verifica el código y que el foco se traslada a «Iniciar nueva consulta». La acción debe volver a la primera página sin reusar el cursor previo ni presentar éxito falso.
4. **Falla de transporte:** se aborta intencionalmente una petición real desde Chromium; no aparecen elementos inventados ni anteriores. El foco se traslada a «Reintentar», y al pulsarlo obtiene los 11 elementos mediante una nueva respuesta real.
5. **Cambio de empresa:** se cierra la sesión desde la UI, desaparecen la cookie y el panel anterior, se registra una segunda empresa real por la misma UI y, tras verificar su módulo, abre una bandeja **vacía**, sin órdenes de la primera ni cursores que permitan volver a sus páginas.

Los fallos de cada aserción detienen CI; no se deshabilitan por flakiness ni se usan sleeps ciegos en navegación (se espera DOM o respuesta observables). La manipulación intencional de la firma y el aborto de transporte son **escenarios negativos del cliente**, claramente separados de las respuestas de éxito generadas por el backend real.

## Riesgos y límites

- **No es una auditoría manual de VoiceOver/TalkBack**: Chromium verifica foco, teclado y atributos, pero quedan lectores de pantalla/tecnologías asistivas para aceptación humana.
- Los cursores son un recorrido keyset anclado, **no un snapshot inmutable** de estados de órdenes.
- Una prueba positiva de bandeja no acredita ejecución física, aplicación agronómica, integridad de cada evidencia, checklist aceptado ni aprobación administrativa.
- Se mantiene abierto el [issue #86](https://github.com/FedesConsultora/SedeAgro/issues/86) relativo a la estabilidad histórica del foco en otro modal. Este PR no toca sus componentes ni rebaja sus controles.
- El workflow integra el nuevo gate antes del merge; una corrida verde del PR no reemplaza una segunda ejecución sobre el **SHA resultante del merge normal**.
- No hay nuevos permisos, migraciones, RLS policies, secretos, cambios de auth, scouting, GIS, offline, inventario, workers ni despliegue VPS/producción. Rollback: revertir el script y el paso dedicado del workflow, preservando los contratos previos.
