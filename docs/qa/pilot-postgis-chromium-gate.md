# Piloto SedeAgro 0.1 — CI PostGIS / navegador independiente (#255)

## Problema confirmado y límite de la evidencia

En el run exact-head [#40563624606](https://github.com/FedesConsultora/SedeAgro/actions/runs/40563624606) del PR #254, el primer intento consumió el límite de 20 minutos de `tenant-rls` y fue cancelado dentro de `Run real Chromium cookie and session acceptance against PostgreSQL`. El segundo intento focalizado **sí terminó SUCCESS** con el mismo HEAD. Por lo tanto, la primera cancelación fue un problema real de presupuesto de tiempo de job, no evidencia de que los casos funcionales de Chromium fallasen.

El job anterior concentraba auditorías estáticas/unitarias, migración PostGIS, suite `test:db` multiempresa con rol no propietario, benchmarking, backup→restore y, recién al final, instalación de Playwright/Chromium, **dos ejecuciones completas de 12 ciclos de accesibilidad** más pruebas navegador de evidencias/inbox. La herramienta GitHub asignaba 20 minutos *a todo ese conjunto*, haciendo que instalar el navegador consumiera parte del tiempo de la validación de RLS.

## Nueva topología de aceptación exact-head

- **`tenant-rls` (20 min):** mantiene Node22/npm ci, todo static/unit frontend+backend, PostGIS migración/seed, rol aplicación real, `test:db`, benchmarks y backup/restore/red aislada. No instala Chromium ni corre los scripts E2E de navegador.
- **`browser-postgis` (35 min, paralelo):** checkout y comprobación exacta del SHA evento, misma imagen PostGIS 16.3.4 por digest, arquitectura amd64, base disposable `sedeagro_test`, npm ci, pruebas de huella fresh-install antes/después, migración+seed CI, provisión con `scripts/provision-runtime-role.sql` del rol `sedeagro_app` no propietario, instalación Playwright Chromium fijado, y **los mismos** `acceptance-browser-cookie.mjs` dos veces con `SEDEAGRO_FOCUS_STRESS_CYCLES=12`, `acceptance-browser-evidence-history.mjs`, `acceptance-browser-review-inbox.mjs`. No se reduce ni relaja cobertura. Cada job usa contenedor PostGIS separado y su propio puerto 5432 local en runner aislado; no comparten datos.
- **`browser-offline`, `dependency-security`, `production-images`:** siguen independientes y sin cambios funcionales. Los jobs de OCI y reconstrucción/importación sólo se ejecutan en push de main como antes.
- **Contrato de bases OCI fijadas:** `scripts/verify-base-image-pins.mjs` ahora exige **exactamente dos** declaraciones de imagen PostGIS para `.github/workflows/postgres-isolation.yml` (antes exigía una). Ambas están ancladas al **mismo SHA256 aprobado**; pruebas en `scripts/test/base-image-pins.test.mjs` rechazan imagen faltante, extra, mutable o digest alterado. En el primer intento exact-head, este guard falló de manera correcta hasta actualizar la cardinalidad: no fue un error del registry.
- **`scripts/test/postgis-browser-workflow.test.mjs`:** regresión estructural ejecutada en `tenant-rls`, que bloquea la eliminación del nuevo job, cambios del SHA exacto, alteración de digest, falta de rol app, reducción de dos pasadas/foco o desaparición de los 3 scripts E2E. Es una defensa contra cambios posteriores y NO sustituye E2E real.

## Aceptación operativa

El PR necesita **5/5 jobs SUCCESS sobre el HEAD exacto**, ahora incluyendo `browser-postgis`. Tras merge normal, la CI independiente de main debe completar **7/7 jobs**, contando atestación OCI/import de imágenes. Verificar ambos eventos por SHA y no mezclar evidencias previas. Comparar la duración real contra histórico: menor wall-clock para `tenant-rls` y ausencia de cancelaciones por el techo de 20min. 35 min es un límite más amplio para el navegador, no garantía de que no haya regresiones de performance.

No se modifica código aplicativo, migraciones, políticas FORCE RLS, semántica de pruebas, secretos productivos, VPS, despliegues ni decisiones de release. `memberships` sin FORCE RLS (#232), cold start autenticado offline (#163), seguridad externa, staging y QA física permanecen bloqueantes. #130 sigue **NO-GO**.
