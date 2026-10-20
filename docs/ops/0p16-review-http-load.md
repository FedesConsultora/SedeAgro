# 0P.16 — Primer benchmark HTTP real de review-queue (5.000 órdenes)

## Problema que se investiga (#143)

Los bloques 0P.10A/B midieron 240/1.200 órdenes usando `EXPLAIN ANALYZE BUFFERS`. El resultado **no** mide serialización JSON, ORM, extracción de partes/evidencia, validación de HMAC, cookies de sesión ni latencia del endpoint completo `GET /api/v1/work-orders/review-queue`. Antes de habilitar pilotos mayores hace falta evidencia sobre el endpoint real, no una extrapolación de tiempos SQL.

## Nuevo escenario ejecutable en GitHub

En el gate existente de `tenant-rls` (PostGIS 16.4 + migraciones, dos tenants reales, rol limitado FORCE RLS y Chromium+Express) se ejecuta `scripts/benchmark-review-queue-http.mjs` **al terminar las pruebas previas de la UI**, antes del logout/cambio de empresa. Eso evita modificar los resultados deterministas 50/61 y los filtros de la aceptación existente.

Requisitos fail-closed: `CI=true`, `GITHUB_ACTIONS=true`, `SEDEAGRO_HTTP_LOAD_PROBE=I_ACCEPT_ONLY_GITHUB_DISPOSABLE_TEST_DATABASE`, URLs PostgreSQL `localhost/127.0.0.1` con base `*_test` común y roles propietarios/runtime distintos. Rechaza endpoints HTTP fuera de `127.0.0.1:4177`. No usa VPS, staging, secretos externos ni datos privados.

El owner de un tenant autenticado recibe 5.000 órdenes **sintéticas** por lote, con diferentes tipos (application/sowing/harvest/inspection), prioridades (normal/high/urgent), vencimientos (nulo, pasado, próximo), estados de partes (sin parte, submitted propio/ajeno y verified), y títulos prefijados `PilotLoad`. Se crean 4.000 partes sintéticos. Un segundo tenant de la aceptación Chromium debe seguir viendo **cero** órdenes del primero luego de cambiar la identidad y la cookie.

Nueve consultas combinan `q=PilotLoad` con:
- newest/all, no_report, blocked, review, closure;
- application, priority urgent + priority_first, due overdue + due_first;
- application + blocked + urgent + overdue + due_first.

Cada una hace **7 llamadas GET HTTPS-equivalentes solo a nivel HTTP local** (proxy Vite → Express en loopback): valida 200, página acotada de 50, array de UUID sin duplicados, mismo orden de IDs entre muestras sin escrituras, segundo page mediante cursor HMAC real, ausencia de solapamiento, pertenencia SQL real al tenant, y 422 del backend al modificar el cursor o reutilizarlo con otro sort. Se publican `REVIEW_HTTP_LOAD=` con p50/p95/p99 **nearest-rank** de tiempo total cliente Node (incluye red loopback, Express/ORM/PostgreSQL/JSON), duración de página 2, número de filas y metadata acotada de CPU/RAM/versiones. No se imprimen cookies, JWT, URI del DB, UUID de persona/empresa, título privado ni tokens de cursor.

Los tests unitarios adversariales en `scripts/test/benchmark-review-queue-http.test.mjs` rechazan configuraciones externas, entradas malformadas, métricas incompletas, duplicados y respuestas sin paginación firmada. Se preservan los cuatro jobs existentes de CI, incluidos build Docker y auditoría npm.

## Interpretación y GO

- **Este bloque cubre únicamente 5.000 órdenes en la DB descartable de CI**, con cliente HTTP local autenticado y requests secuenciales. No representa HTTPS, balanceador, latencia celular/rural, concurrencia ni hardware de staging.
- Los p95 y p99 de **solo 7 mediciones** son descriptivos, no percentiles robustos de carga y no autorizan fijar un SLO comercial. Sin presupuesto de latencia validado con usuarios/operación, no se aprueba rendimiento productivo.
- #143 queda **ABIERTO**: faltan 20k/50k órdenes por tenant, distribuciones sesgadas con excepciones/insumos/evidencias, lecturas concurrentes, mezcla de tenants, comparativa SQL/HTTP en staging aislado, límites de infraestructura y decisión humana de SLO.
- La certificación global #130 requiere separadamente TLS, backup/restauración REAL privado, rollback ensayado, Android/iOS y offline rural con evidencias; un workflow SUCCESS no demuestra GO de producción.
