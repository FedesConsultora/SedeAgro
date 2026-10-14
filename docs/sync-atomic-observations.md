# Bloque 0H — sincronización segura de observaciones y trazabilidad

## Problema que se corrige

El endpoint anterior aceptaba operaciones arbitrarias bajo `POST /sync/batches`, grababa filas `received`/`pending` y respondía 202, **sin ningún worker que aplicara las operaciones**. La pantalla web simulaba sincronización mediante un temporizador e incluso ocultaba errores reales mostrando lotes demo.

El contrato nuevo **aplica inmediatamente**, en una única transacción PostgreSQL/PostGIS, solo la creación de **observaciones de monitoreo**. No se anuncian otros tipos como soportados. No hay todavía una app móvil offline ni un trabajador de sincronización continua.

## Contrato de envío

`POST /api/v1/sync/batches` requiere JWT, tenant activo, capability `sync.submit` y entitlement `scouting`.

```json
{
  "client_id": "mobile-sedeagro",
  "device_id": "device-local-01",
  "idempotency_key": "27f9738d-ed46-4e5f-983c-69a7ce7a3cd9",
  "operations": [
    {
      "entity_type": "scouting_observation",
      "entity_client_id": "e68acc98-5187-4870-9b27-d6a939a22bd2",
      "operation": "create",
      "payload": {
        "scouting_run_id": "637bd94d-0716-49c9-a2d0-a7db290fc915",
        "observation_type": "pest",
        "severity": "high",
        "notes": "Puntos con insectos en borde norte"
      }
    }
  ]
}
```

- Máximo **50 operaciones por lote**, todas con ID de cliente UUID único dentro del lote.
- Se rechazan operaciones `update`, `delete`, otro `entity_type`, campos no declarados, referencias a otro tenant o recorridas no asignadas, y recorridas cerradas.
- El servidor deriva `field_id` desde `campaign_field_id` de la recorrida. Nunca acepta un lote o `observed_by` enviado por el cliente.
- Bloquea las filas de recorridas de manera determinística por UUID antes de crear observaciones, para serializar cambios concurrentes contra reasignaciones y cierres.
- Si una sola operación es inválida, **se revierte todo el lote**, incluidas observaciones, resultados y auditoría.
- Si todas son válidas, retorna HTTP **201** con `status: processed`, operaciones `status: applied` e IDs de observación creados. La respuesta se transmite después del commit, según Bloque 0D.

## Reintentos

El cliente conserva `idempotency_key` y el cuerpo exacto hasta obtener respuesta. El índice único de `sync_batches(tenant_id, submitted_by, idempotency_key)` protege envíos concurrentes. La clave es propia del actor y del tenant.

- **Misma clave y mismo cuerpo:** HTTP 200, `replayed: true`, devuelve IDs guardados y no crea nuevas observaciones.
- **Misma clave y cuerpo distinto:** HTTP 409 `SYNC_IDEMPOTENCY_CONFLICT`.
- **Fallo de validación/permisos/transacción:** HTTP 4xx/5xx y rollback total. Un reintento requiere volver a comprobar autorización y estados reales.

La migración `202610140004_sync_idempotency.js` agrega campos nulos a lotes existentes y resultados JSON por operación; **no declara procesados los lotes históricos `received`**. Estos siguen sin aplicar y requieren migración explícita o reenvío usando el nuevo contrato.

## Recibos y auditoría

- `GET /api/v1/sync/batches` (`sync.read`): coordinador/admin, hasta los 100 más recientes.
- `GET /api/v1/sync/my-batches` (`sync.submit`): solo lotes enviados por el usuario autenticado. No expone los recibos de otros monitoreadores.
- `GET /api/v1/scouting/runs/:id/audit` (`scouting.audit.read`): administrador o coordinador, hasta 100 cambios recientes de la recorrida. El monitoreador no puede consultar el historial administrativo.

La tabla `audit_events` ya existía. Se utiliza transaccionalmente para altas y cambios de recorridas, observaciones online y sincronizadas, y evidencias. Cada fila registra tenant, actor, acción, entidad, request ID y metadatos limitados. **No se duplican notas de campo, cuerpos de petición, credenciales ni archivos**. No es todavía un log inmutable criptográficamente ni sustituye backups o medidas de retención.

## Interfaz web

La pantalla Sincronización ahora **refresca datos reales** y muestra el estado de cada lote. El botón no finge sincronizar un dispositivo. Si el backend falla, se muestra un error con reintento, sin fallback silencioso a mock. Los datos demo se identifican explícitamente. En detalle de Monitoreo, administradores/coordinadores pueden abrir el historial auditado.

## Verificación requerida

En cada PR, GitHub Actions ejecuta unit tests, build Vite, migraciones desechables sobre PostGIS 16, usuario PostgreSQL limitado y `npm --workspace backend run test:db`. La prueba nueva de sincronización comprueba duplicados idempotentes, rechazo de lote cruzado, rollback integral, recibos por autor, auditoría sanitizada y cierre de recorridas.

**Límites pendientes:** sincronización automática desde el móvil, resolución de conflictos de actualizaciones/desborrados, uploads offline de evidencias, criptografía de audit log, políticas de retención/cuotas y compatibilidad de clientes antiguos. No desplegar al VPS sin backup y runbook `docs/security/postgres-rls-runbook.md`.
