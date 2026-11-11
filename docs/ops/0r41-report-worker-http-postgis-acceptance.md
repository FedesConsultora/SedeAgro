# 0R.41 — RP-02: aceptación real del procesador de reportes con PostGIS

**11/11/2026 · Release 0.1: NO-GO.**

## Vacío de aceptación

La matriz #166 identificaba RP-02 (worker real, jobs completados, caducidad, reintento, cancelación e integridad SHA) como parcialmente cubierto. Existían tests estructurales de `reportWorker.js` y métricas PostGIS de `reportWorkerHealth.pg.mjs`, pero **faltaba un caso integral, sin mocks**, que ingresara un reporte por HTTP, hiciera procesar esa misma fila por el worker bajo el rol de aplicación y descargara los mismos bytes desde la API.

## Nuevo caso: `backend/test/reportWorkerPipeline.pg.mjs`

El test se incorpora automáticamente a `npm --workspace backend run test:db` porque éste ejecuta `test/*.pg.mjs`, incluido por el job `tenant-rls` exact-head en cada PR/main.

1. Exige **dos URLs PostGIS `*_test`** y comprueba que el worker usa un rol sin `SUPERUSER`, sin `BYPASSRLS` y distinto del propietario de la DB. Crea dos empresas y miembros dentro de la DB descartable; nunca solicita ni usa base real.
2. El administrador autenticado crea una plantilla CSV de lote por el endpoint HTTP real. La creación de jobs sin heartbeat debe devolver **503**, nunca una falsa cola habilitada.
3. Tras `markReportWorkerPresent(tenant A)`, la API devuelve estado online y responde **202** con un trabajo `queued`. La descarga antes de procesar devuelve **409**; el administrador del tenant B recibe **404** al consultar o descargar ese ID.
4. `processNextReport(tenant B)` devuelve `idle`: el worker del otro tenant no puede reclamar filas ajenas. `processNextReport(tenant A)` aplica la cola real, renderiza un CSV desde la lectura RLS, guarda los bytes y marca `completed`. Se verifica `attempt_count=1`, el archivo único en Postgres, `Content` base64, longitud exacta, MIME, filename, datos del lote y SHA-256. Volver a procesar da `idle`, sin duplicados.
5. Cancelar otro trabajo `queued` impide que el worker lo reclame, evita crear un archivo y bloquea descarga.
6. Revocar una plantilla **después de encolar** impide generar bytes aunque el worker siga online; la fila termina en `failed/AUTHORITY_REVOKED` y la descarga en **409**.
7. Caducar el archivo real tras su creación hace que la API devuelva **410**, y `purgeExpiredReportFiles` elimina el contenido persistido.

**Evidencia:** se validan HTTP y filas de la DB descartable; no se afirman pruebas Android/iOS, staging operativo, workers aislados en VPS ni firma de aceptación humana.

## Cómo ejecutar

```bash
# Sólo contra el servicio desechable preparado por CI con propietario y rol runtime separados
TEST_DATABASE_ADMIN_URL=postgres://.../sedeagro_test \
TEST_DATABASE_APP_URL=postgres://.../sedeagro_test \
  node --test backend/test/reportWorkerPipeline.pg.mjs
```

En los jobs existentes de GitHub se invoca mediante `npm --workspace backend run test:db`, no se sustituye ni se omite ninguna prueba preexistente.

## Límites

Este bloque prueba procesar un trabajo individual en **el mismo entorno de test** que ejecuta la API, sin mocks de DB. No constituye aún evidencia de un proceso worker independiente 24/7 en una máquina aprobada, reintentos por muerte del proceso o métricas de estrés con volúmenes reales. La aceptación de seis actores, MOB-05 físico, HTTPS staging y recuperación off-VPS siguen NOT_RUN. **Release #130 mantiene NO-GO.**
