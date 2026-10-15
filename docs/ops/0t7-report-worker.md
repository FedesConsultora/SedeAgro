# 0T.7 — Reportes asíncronos persistentes, aislados por empresa

## Entrega y alcance operativo

El módulo anterior generaba CSV/PDF/XLSX inmediatos y rechazaba `POST /reports/runs` con 409 porque nunca procesaba sus filas. Este bloque incorpora un **worker ejecutable real**, job queue PostgreSQL y archivos persistidos hasta 7 días, exclusivamente para plantillas activas con `scope=field` y formatos `csv`, `pdf`, `xlsx`. No se promete programación calendaria ni alcances campaign/producer todavía.

No modifica ni sustituye los tres endpoints inmediatos. Un worker es **un proceso separado por tenant explícito**, usa exactamente el rol de DB de la API (no propietario, no BYPASSRLS), transacción `SET LOCAL app.current_tenant` y políticas FORCE RLS. No recorre la tabla de tenants ni lee datos de empresas ajenas. Multi-tenant significa aislar trabajos; activar workers de más empresas requiere un proceso por empresa, pendiente de orquestación.

## Flujo transaccional

1. Un operador instala migraciones y aprovisiona el mismo rol runtime en una base de entorno de ensayo; registra una empresa para el worker.
2. Inicia `REPORT_WORKER_TENANT_ID=<uuid> npm --workspace backend run worker:reports`, desde un proceso supervisionado, apuntando al **DATABASE_URL del rol limitado**. La invocación es manual y no se ejecutó contra VPS en este bloque. `--once` es únicamente para smoke/CI.
3. El proceso publica un heartbeat RLS cada ciclo. `POST /reports/runs` solo devuelve **202** y crea una fila si hay heartbeat reciente (20s), plantilla/lote activos y autorizados, cuota total inferior a 10 pendientes por tenant, fechas válidas y `reports.write`. De lo contrario devuelve 503/422/404/429/403 con error explícito.
4. El worker toma una fila bajo bloqueo transaccional `pg_try_advisory_xact_lock` por tenant y `FOR UPDATE SKIP LOCKED`, pasa a `running`, genera UUID de lease, expira a 120s y aumenta `attempt_count`.
5. Obtiene snapshot tenant/RLS con el mismo límite del CSV 0T.5: 200 observaciones + 200 órdenes y 1 MiB de origen. Genera CSV, PDF o XLSX real y acotado a 3 MiB, sin enlaces externos ni macros.
6. En una única transacción confirma `completed` por CAS de `lease_token` y escribe los bytes en `report_run_files` (máximo 3 MiB) con SHA-256, MIME, formato, FK compuesta de empresa y vencimiento a 7 días. Un worker que perdió el lease o un trabajo cancelado no puede revivir la fila.
7. Las fallas terminales (acceso revocado, archivo demasiado grande, formato no permitido) pasan a `failed` y exponen **solo códigos**. Errores temporales vuelven a `queued` con 15s de reintento; hasta 3 intentos. Una lease vencida y agotada pasa a `RETRY_EXHAUSTED`.
8. `GET /runs` devuelve hasta 30 trabajos recientes; `GET /runs/:id` consulta progreso. `POST /runs/:id/cancel` cancela solo queued/running. `GET /runs/:id/download` exige `reports.read`, verifica estado completed, expiración, SHA-256, tamaño y formato antes de responder JSON privado `no-store`; el cliente verifica nuevamente SHA-256 con Web Crypto antes de descargar. Los artefactos vencidos se purgan en cada ciclo de mantenimiento del worker.

## Límites y criterios de seguridad

- RLS no es decorativo: `report_run_files` y `report_worker_presence` usan ENABLE/FORCE y FK compuesta tenant/run.
- El worker no tiene secretos HTTP/JWT, solo el acceso DB del rol runtime. No comparte claves entre empresas. No emplea `BYPASSRLS`, superusuario ni scanning global.
- No hay archivos persistidos en disco local ni logs de contenido agronómico/PII. Los códigos de error no incluyen notas privadas ni SQL. Backups PostgreSQL de staging deben contemplar `report_run_files`, por su contenido privado.
- El heartbeat es una **prueba reciente de disponibilidad, no una garantía de procesamiento** tras crash abrupto. Un apagado posterior a la aceptación puede retrasar una fila hasta que el supervisor reinicie el worker. Un worker por tenant debe mantenerse activo y monitorearse; no existe orquestador multiempresa incorporado.
- Los trabajos creados antes de 0T.7 como `queued` necesitan una revisión operativa; no se infiere que estén autorizados o sean regenerables.
- Límites duros: 10 pendientes por empresa, 2 leases activas por empresa en reclamo, tres intentos, 120 segundos por lease, 7 días de retención de binarios.
- No hay cola programada por hora/fecha, plantillas agregadas por campaña/productor, enlaces públicos, email ni despliegue de workers automático.

## QA y piloto

En CI comprobar: migración en PostGIS disposable, FORCE RLS de tablas nuevas, `POST` sin worker rechaza sin dejar filas; template activo y field tenant-scoped; work claim real, progreso, bytes/digest y descarga; cancel y competencia; rol scout sin reports.read; bytes de otra empresa no accesibles; el ensayo de backup/restore 0T.4 incluye estas nuevas tablas; frontend lint/build/test offline y worker CLI check.

**Aún NOT_RUN:** despliegue del worker supervisado en staging, reconexión por fallo de red, kill -9 en medio del render, performance sobre datos reales, limpieza a los 7 días reales, backups/restauración de staging, aceptación física móvil y pase productivo. Como 0T.3/0T.4, un CI verde no implica GO para piloto.

## Operación segura

En un entorno no productivo, luego de migraciones y permisos runtime, una vez configurado el entorno de backend:

```bash
REPORT_WORKER_TENANT_ID=<UUID-DE-EMPRESA> npm --workspace backend run worker:reports
```

Usar un supervisor que reinicie en falla, reporte heartbeat offline y preserve logs sin contenido. Para piloto con múltiples empresas, autorizar instancias separadas por UUID y fijar cuotas CPU/memoria. No instalar ni iniciar el worker en producción sin completar los gates de `docs/ops/0t3-staging-release-gates.md`.
