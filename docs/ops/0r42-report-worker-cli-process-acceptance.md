# 0R.42 — RP-02 con worker CLI real en proceso independiente

**11/11/2026 · Piloto 0.1 · Release #130 permanece NO-GO.**

## Qué faltaba tras 0R.41

La PR #325 agregó una prueba integral del API/colas/PostGIS y corrigió la clasificación de plantillas revocadas, pero la aceptación en CI ejecutaba `processNextReport()` dentro del mismo proceso del test. Eso no acreditaba que el entrypoint operativo `backend/src/workers/reportWorkerCli.js --once` iniciara, recibiera **un solo tenant autorizado**, trabajara con la conexión PostgreSQL runtime no propietaria y terminara sin conexiones colgadas.

## Nueva aceptación descartable

`backend/test/reportWorkerPipeline.pg.mjs` sigue siendo ejecutado automáticamente por `npm --workspace backend run test:db` bajo los jobs `tenant-rls` de PR y main. La prueba ahora abre procesos Node separados mediante `spawn(process.execPath, [workerCli, '--once'])`, **sin shell**, sin argumentos SQL, sin credenciales de propietario y con variables de entorno de PostGIS `*_test`. El proceso recibe solo el `DATABASE_URL` de aplicación non-owner y `REPORT_WORKER_TENANT_ID` canónico de su fixture. `TEST_DATABASE_ADMIN_URL` y `TEST_DATABASE_APP_URL` se retiran del entorno hijo; la propia conexión se comprueba non-owner y sin BYPASSRLS antes de la prueba.

- **Tenant B:** el proceso arranca y termina correctamente, marca su presencia, pero no puede reclamar una fila pendiente de A. No se genera archivo ni se cambia su estado.
- **Tenant A:** se inicia un segundo proceso, que reclama exactamente un job creado vía HTTP, genera CSV real desde PostGIS y lo persiste. El proceso termina código 0 y emite un evento estructurado `report_worker_job` con `state=completed`, `run_id` esperado y sin código de error.
- **Ciclo posterior:** otros procesos `--once` no resucitan una fila cancelada; convierten una lease vencida tras el tercer intento en fallo terminal; el tick de mantenimiento remueve artefactos ya vencidos sin volver a generar trabajos.
- El test verifica vía HTTP `409/404/410`, hash SHA-256 de bytes reales, y SQL independiente de estado, `attempt_count` y unicidad del archivo.
- Cada proceso debe salir normalmente sin errores por stderr. La captura de logs está acotada a 32 KiB, con timeout de 15 segundos y terminación forzada del hijo si se atasca. El test no imprime credenciales de BD en un fallo y solo inspecciona eventos JSON conocidos.

El resto de las pruebas de integración real de revocación y tenant siguen en la misma suite; no se insertan mocks de servicio, no se cambia el backend de producción y no se saltean controles preexistentes.

## Limitaciones y decisión

Esta es **aceptación de código en CI sobre PostGIS descartable**, ejecutando procesos Node reales y separados en el mismo runner efímero. **No** acredita operación 24/7 en un VPS autorizado, reinicios reales del gestor de procesos, cortes de energía, almacenamiento/backup fuera del VPS, RTO/RPO, staging HTTPS o aceptación física Android/iOS. El protocolo de release #130 exige además matriz por seis actores, pruebas de dispositivo y las cuatro firmas humanas independientes.

**Producción: NO-GO.**
