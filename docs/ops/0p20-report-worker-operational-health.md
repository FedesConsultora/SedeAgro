# 0P.20 — Observabilidad mínima de workers de reportes por tenant

## Brecha de operación corregida

0P.19 habilita un worker opt-in con `restart: unless-stopped`, pero no contaba con healthcheck ni alarma de reinicios. Además, el heartbeat se publicaba al principio del ciclo: si el render tomaba más de 20 segundos, el backend podía rechazar otra solicitud como `REPORT_WORKER_OFFLINE` aunque un worker siguiera vivo.

Este bloque incorpora heartbeat periódico en paralelo con el render, una inspección PostgreSQL read-only y un control read-only del estado Docker. **No instala monitores externos, no envía alertas, no reinicia contenedores ni habilita staging/productivo automáticamente.**

## Implementación

- El worker mantiene el heartbeat cada 5 segundos en una transacción propia mientras renderiza. Nunca superpone escrituras de timer; durante shutdown SIGTERM/SIGINT detiene el timer, espera el write en curso y cierra Sequelize. Un error de escritura publica solo el código fijo `HEARTBEAT_WRITE_FAILED` y conteo de fallas consecutivas, sin SQL, URL, payload ni claves.
- La imagen backend de 0P.19 ahora incluye `scripts/report-worker-health.mjs`. El healthcheck Compose opt-in invoca ese archivo cada 15 segundos, con timeout 8s, 3 fallos consecutivos y gracia de 45s. No hay nuevos puertos ni permisos.
- La lectura conecta con el mismo `DATABASE_URL` del rol runtime autorizado, valida usuario distinto del owner sin SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB, exige SHA y aprobación de tenant, inicia `BEGIN READ ONLY` y fija `app.current_tenant` con `set_config(...,true)`. Filtra expresamente `tenant_id=$1` en reportes y presencia. `ROLLBACK` cierra el scope. No lee contenido de informes, productores ni notas.
- Las métricas agregadas son: edad del heartbeat, cola queued, edad máxima de trabajo elegible, running vigente, leases vencidas más de 15 s y trabajos failed de los últimos 10 minutos. Tiempos calculados por el servidor PostgreSQL; sin timestamps privadas en salida.
- Estado **critical** (exit 2): heartbeat ausente o >=20s, lease vencida >15s, trabajo elegible esperando >=300s, capacidad de running inconsistente (>2), error de conexión/consulta/configuración. Docker pasa a `unhealthy` tras repetición.
- Estado **warning** (exit 0 del healthcheck, pero JSON con `status:warning`): cola elegible >=120s, >=10 queued o al menos 1 trabajo failed recientemente. **Un warning no equivale a saludable operativo sin revisión.** Puede ser una falla legítima del informe; exige observación humana.
- Estado **healthy**: heartbeat vigente sin avisos. No demuestra que el worker podrá procesar el próximo reporte; sí elimina varios falsos positivos/falsos negativos del heartbeat.
- `scripts/check-report-worker-compose.sh` inspecciona **sin escribir** el único container del servicio perfilado y valida SHA OCI, estado running, Docker HEALTHCHECK y contador de reinicios. Sale 0 en éxito, 1 si el servicio está bien pero ya reinició una o dos veces, 2 si está detenido, unhealthy, sin label esperado o con 3+ reinicios. No imprime el archivo Compose (puede contener credenciales). No inicia, detiene ni reinicia nada.

## Pruebas

- `node --test backend/test/reportWorkerHealth.test.js`: expiración de heartbeat, atrasos, leases, fallos, valores falsificados, lectura read-only, rol peligroso, rollback, timer no concurrente, parada y redacción.
- `node --test scripts/test/report-worker-compose-health.test.mjs`: Docker simulado, estado, labels, contador y aprobación exacta.
- `npm --workspace backend run test:db` en GitHub CI incluye `backend/test/reportWorkerHealth.pg.mjs` con PostGIS realmente migrado y rol FORCE RLS: crea dos tenants descartables, comprueba que backlog/stale del tenant B no filtra a A y verifica bloqueos por owner/ausencia de heartbeat. Solo admite base `*_test`. **No ejecutar este test sobre datos privados.**
- CI premerge y posmerge del SHA definitivo deben aprobar los cuatro jobs; documentar cualquier falla. Ningún test unitario simulado se presenta como Docker real.

## Staging / aceptación operativa pendiente

1. Autorización separada para un staging aislado sin cuentas demo, revisar origen de imagen/labels SHA y rol RLS. No activar worker contra la base productiva.
2. Habilitar un único tenant piloto como en 0P.19. Ejecutar `docker compose -f docker-compose.yml -f docker-compose.report-worker.yml --profile reports ps` sin imprimir `config`.
3. Desde el host autorizado, invocar `bash scripts/check-report-worker-compose.sh` con SHA/tenant/aprobación en entorno protegido. Configurar scheduler o alertmanager **externo** que interprete exit 1 y 2; por ahora NO existe ni se afirma una notificación automática.
4. Probar 202→completed→download correcto, cancelación, 503 al desactivar worker, reintentos, falla deliberada de DB, render >20s con heartbeat vigente, caída SIGKILL, aumento del contador de reinicios, colas viejas y observabilidad del resultado. No crear datos reales para inducir fallas.
5. Decidir umbrales a partir de tiempos de render medidos en staging; no considerar esta política un SLO comercial. Docker **NO reinicia automáticamente** un contenedor marcado unhealthy: requiere un monitor externo y responsable de incidentes.
6. Mantener #130 en NO-GO hasta HTTPS/SHA real, restore privado, rollback con escrituras posteriores, pruebas Android/iOS y firma humana. Si el worker no se prueba, excluir los reportes asíncronos del piloto.

No se modifican esquemas, migraciones, endpoints, workers de otras empresas ni el Compose principal. El proceso es voluntario por tenant y se puede revertir omitiendo el manifiesto secundario del deployment autorizado.
