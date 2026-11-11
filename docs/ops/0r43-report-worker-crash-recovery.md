# 0R.43 — Recuperación real del worker de reportes tras SIGKILL en PostGIS descartable

**11/11/2026 · SedeAgro 0.1 · RP-02 · Release #130: NO-GO.**

## Brecha del piloto

0R.41 y 0R.42 acreditaron API/cola/bytes privados bajo FORCE RLS, y el proceso operativo independiente `reportWorkerCli.js --once`. Faltaba probar qué ocurre cuando el proceso muere **entre reclamar una fila y persistir los bytes**: recuperación tras vencimiento de su lease, no resurrección fraudulenta de trabajo ajeno, ausencia de archivos duplicados y capacidad de reiniciar el proceso.

## Test real y determinista

`backend/test/ops/reportWorkerCrashRecovery.pg.mjs` lanza procesos Node reales y usa únicamente las credenciales de `TEST_DATABASE_APP_URL` del rol non-owner (nunca pasa al hijo la URL del propietario).

1. Comprueba al iniciar que `TEST_DATABASE_ADMIN_URL` y `TEST_DATABASE_APP_URL` apuntan a bases `*_test`, que el rol runtime no es propietario, superuser, BYPASSRLS ni CREATEDB/CREATEROLE. Construye un tenant, miembro admin, módulo reportes, establecimiento, lote, plantilla CSV y job queued solamente en esa DB descartable.
2. **Posicionamiento determinista de la caída:** una transacción del propietario bloquea temporalmente `report_templates` con `ACCESS EXCLUSIVE`. El **primer proceso** `reportWorkerCli.js --once` reclama y confirma `status=running, attempt_count=1, lease_token, lease_expires_at` en `report_runs`, pero queda bloqueado antes de leer la plantilla y generar el CSV.
3. El test envía **SIGKILL** al proceso real y exige que termine por señal, sin evento de completado. Libera el bloqueo mediante `ROLLBACK`, vuelve a leer la fila (sigue `running` con el mismo token) y verifica **cero archivos** persistidos.
4. En la fixture descartable, modifica únicamente `lease_expires_at` y `last_seen_at` a 30 segundos en el pasado para simular que pasaron los 120 segundos reales de lease. Nunca reduce timeouts de producción. `inspectReportWorkerHealth` con el rol runtime informa `critical` y las razones `HEARTBEAT_STALE` y `LEASE_OVERDUE`.
5. Un **segundo proceso independiente** `--once` recupera exactamente el job anterior, lo procesa, emite un único evento `completed` y sale con código cero. Se verifica `attempt_count=2`, ausencia de lease/token, **un solo archivo privado**, longitud exacta y SHA-256 del CSV persistido. Health retorna `healthy`.
6. Un **tercer proceso** `--once` no reclama de nuevo el trabajo ni duplica bytes. Un cuarto proceso, esta vez **persistente**, publica un heartbeat y recibe SIGTERM; debe cerrar normalmente con código cero y sin producir nuevos archivos.

Los subprocessos se ejecutan **sin shell**, con salida JSON acotada, sin imprimir errores SQL, y timeout de 16 segundos por hijo. El test tiene timeout global 45 segundos y limpieza `finally`: termina procesos huérfanos, libera el bloqueo y elimina el tenant de prueba.

## CI / concurrencia

El test se ubica deliberadamente fuera de `backend/test/*.pg.mjs` porque su bloqueo de tabla, aunque breve, no debe coincidir con las suites concurrentes. En `.github/workflows/postgres-isolation.yml`, el job obligatorio `tenant-rls` ejecuta un paso **serial**, inmediatamente después del `test:db` actual y antes de los benchmarks y el restore. Un fallo impide aprobar la PR.

```bash
# ÚNICAMENTE con PostGIS migrado y roles owner/runtime de prueba:
TEST_DATABASE_ADMIN_URL='postgres://…/sedeagro_test' \
TEST_DATABASE_APP_URL='postgres://…/sedeagro_test' \
  node --test backend/test/ops/reportWorkerCrashRecovery.pg.mjs
```

## Límites

La caída es real (**SIGKILL al proceso**) y la nueva ejecución es real, pero el paso del tiempo de lease se **simula exclusivamente cambiando timestamps de la fixture**. Se prueba integridad y recuperación de una fila/archivo en un runner temporal, **no** se ensaya caída del host, varios workers concurrentes bajo supervisor, interrupción eléctrica, filesystem real, 24/7, SLA de tiempo real ni restauración off-VPS. No se altera código de producción, migraciones, API, staging, VPS, secretos o datos reales.

**Release #130 continúa NO-GO**: staging HTTPS autorizado, restore externo con RTO/RPO y rollback, aceptación Android/iOS física, seis actores y firmas humanas independientes pendientes.
