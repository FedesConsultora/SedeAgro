# 0P.19 — Worker de reportes optativo y delimitado por empresa

## Brecha antes del piloto

`POST /reports/runs` y el procesamiento PostgreSQL con FORCE RLS ya existen. Pero el `docker-compose.yml` principal no ejecuta ni supervisa el worker. Sin un proceso disponible por empresa, la API rechaza los trabajos asíncronos con 503, correctamente. **Una prueba en CI no significa que la cola opere en staging.**

Este bloque agrega un servicio Compose **separado, desactivado por defecto**, para **una única empresa autorizada**, con reinicio tras fallo y límites de recursos. No incorpora descubrimiento automático de tenants ni permite un worker privilegiado compartido.

## Contrato técnico

- `docker-compose.report-worker.yml` se usa **solo** agregándolo explícitamente como segundo archivo Compose y seleccionando el perfil `reports`. El Compose normal de producción queda sin cambios.
- Un contenedor por proyecto Compose, un UUID de empresa en `REPORT_WORKER_TENANT_ID`. No existe auto-enrolamiento ni recorrido de empresas. Varias empresas requieren despliegues aislados por tenant, aprobados por separado; no ejecutar múltiples stacks sobre el mismo conjunto de contenedores sin diseñar esa orquestación.
- Startup exige `SEDEAGRO_BUILD_SHA` de la imagen, `SEDEAGRO_REPORT_WORKER_APPROVAL=START_REPORT_WORKER:<SHA40>:<UUID>`, `NODE_ENV=production`, `SEED_MODE=prod`, sin SQL ni stack logs. Un SHA o tenant distinto impide iniciar el proceso.
- La conexión solo admite el servicio PostgreSQL interno `db:5432`, el nombre de DB elegido y el usuario `APP_DB_USER` distinto de `POSTGRES_USER`. La conexión real valida después en `connectDb()` que el rol no sea propietario ni tenga SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB.
- No se monta `backend/.env`; **nunca entregar el JWT_SECRET verdadero de la API al worker**. Debido a que el validador común `config/env.js` actualmente exige `JWT_SECRET` en todo proceso Node productivo, el worker recibe únicamente un marcador explícito, no aceptado por la API, derivado del SHA: `sedeagro-worker-no-api-auth-<SHA40>`. Su startup rechaza cualquier valor diferente. Esto es una compatibilidad temporal que habrá que eliminar cuando se separen las configuraciones de procesos; **el marcador no es un secreto de autenticación**.
- Contenedor no root, filesystem read-only, `/tmp` en tmpfs, sin puertos al host, sin red `fedes-net`, sin Redis, sin migraciones ni seeds, sin capabilities Linux y con `no-new-privileges`. Reinicio `unless-stopped`; límites 512 MiB de memoria, 1 CPU y 128 PID.
- El worker existente atiende señales SIGTERM/SIGINT y se configura una espera de 150 segundos antes de terminarlo. **No hay garantía** de completar un render in-flight tras crash; leases expirables y reintentos son el mecanismo existente. No se agrega endpoint de salud público.

## Aceptación sin tocar VPS

1. Reproducir `node --test backend/test/reportWorkerStartup.test.js` y `node --test scripts/test/production-container-guards.test.mjs`. La primera prueba usa solo configuración sintética; la segunda comprueba que el servicio no participa del Compose predeterminado. No conecta a base ni crea workers.
2. Antes de autorizar un staging, un operador con acceso y aprobación independientes debe revisar el SHA exacto, las credenciales de rol runtime, la ausencia de datos demo, la migración del módulo y la pertenencia del UUID al tenant esperado. **No incluir cadenas de conexión, JWT ni credenciales en tickets o logs.**
3. Solo en staging **aislado y autorizado**, preparar en el entorno de Docker las variables `SEDEAGRO_RELEASE_SHA`, `POSTGRES_USER`, `POSTGRES_DB`, `APP_DB_USER`, `APP_DB_PASSWORD`, `REPORT_WORKER_TENANT_ID` y la aprobación exacta `START_REPORT_WORKER:<SHA40>:<UUID>`. Exigir `docker compose -f docker-compose.yml -f docker-compose.report-worker.yml --profile reports config --quiet` y revisar que el servicio pertenezca únicamente a la red interna. Atención: `docker compose config` **sin** `--quiet` puede exponer credenciales; no pegar su salida.
4. Con ventana autorizada, construir la imagen aprobada y habilitar el servicio optativo mediante la combinación explícita de archivos/perfil. No iniciar el worker en una base real solo para obtener un check verde.
5. En una base de staging y con un usuario del tenant correcto: comprobar 503 antes de iniciar el worker; heartbeat después del arranque; creación 202; render `completed` con hash y descarga verificados; dos empresas sin acceso cruzado; reinicio abrupto, leases y reintentos; límites y limpieza. Registrar pruebas de conectividad, recursos y logs sanitizados.
6. Supervisar salida del worker y frescura del heartbeat en cada tenant antes de incluir **reportes asíncronos** en la beta. Si no se habilita y prueba, limitar el piloto a reportes inmediatos CSV/PDF/XLSX y declarar los asíncronos fuera de alcance.

## Límites y decisión

- No se ejecutaron Docker Compose real, PostgreSQL de staging, procesos en VPS, restauraciones privadas ni simulaciones de caída sobre dispositivos físicos como parte de este código.
- Un reinicio automático `unless-stopped` **no garantiza disponibilidad** ni monitorización externa de heartbeat; requiere alerta de ausencia, proceso en estado restart-loop y verificación del supervisor.
- La firma de GO/NO-GO #130 sigue bloqueada por staging real, HTTPS, restore/rollback y aceptación Android/iOS. La aparición de advisories nuevos durante PR #151 también exige volver a aprobar el gate de seguridad exacto.
- Los límites de recursos son iniciales para un ensayo; no equivalen a un SLO medido y deberán ajustarse con reportes representativos.

Este bloque es una **capacidad de despliegue optativa** probada de forma estática y con pruebas de admisión; no una activación en producción.
