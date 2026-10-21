# 0P.21 — Rollback con conservación de escrituras y datos offline (admisión de riesgo)

## Qué riesgo real cierra

La release de SedeAgro ya exige backup/restauración de ensayo antes de migrar (0P.3 y 0P.18), pero una **restauración de ese archivo después de haber habilitado tráfico** puede sobrescribir nuevas observaciones, evidencias, órdenes y recibos de sincronización. Incluso un cambio de una sola fila deja el mismo conteo. La cola offline de un dispositivo desconectado **no aparece en las métricas del servidor**; su ausencia en PostgreSQL jamás demuestra que no haya datos locales por enviar.

0P.21 diferencia dos acciones distintas y NO efectúa ninguna:

1. **Rollback solo de aplicación**: no modificar PostgreSQL; la versión anterior solo entra a revisión si el conjunto exacto de migraciones que ella reconoce coincide con el conjunto aplicado en la DB. La igualdad de nombres no garantiza compatibilidad binaria/semántica de aplicación: requiere pruebas de staging.
2. **Restauración de base desde backup**: bloqueada si la huella de todas las filas/secuencias cambió desde el backup, si el esquema de backup no coincide con el código destino, si el archivo no está verificado, si las escrituras no están detenidas o si dispositivos/operaciones offline no están íntegramente reconciliados. No existe un override que oculte `RESTORE_DATA_DIVERGED`.

La respuesta favorable del evaluador se denomina **`OPERATOR_REVIEW_REQUIRED`**: *jamás* `GO`, `SAFE_TO_RESTORE` ni una acción automática. Se trata de revisión preliminar con información aportada por el operador, **no** de una firma criptográfica, validación de backup, bloqueo transaccional de escrituras ni garantía de ausencia de carreras entre captura y corte.

## Implementación

- `scripts/rollback-decision.mjs`: validador de un JSON de evidencia, sin conexiones, escritura, Docker, migraciones o comandos de despliegue. Exige SHA completos y distintos de versión actual/destino, SHA256 de backup, huellas acotadas de aplicación `tablas|secuencias|digest`, listas ordenadas/no duplicadas de migraciones, y confirmaciones explícitas del operador.
- `scripts/ci-rollback-rehearsal.sh`: ensayo real **solo** dentro del servicio PostGIS descartable de GitHub Actions. Requiere `CI=true`, `GITHUB_ACTIONS=true`, aceptación `SEDEAGRO_DISPOSABLE_RESTORE=I_ACCEPT_ONLY_CI_TEST_DATABASES`, ID hex del contenedor y etiqueta de imagen `postgis/postgis:16-3.4`. Base origen fija `sedeagro_test`, base restaurada fija `sedeagro_restore_test`, rol propietario solo de CI, sin URLs o nombres editables.
- Después de verificar paridad real `pg_dump→pg_restore` en `scripts/ci-disposable-restore.sh`, el ensayo compara las huellas y realiza **dos cambios reales en la base sintética origen**: INSERT de un tenant de prueba después del backup (cambia cantidad de filas) y UPDATE del nombre de plan starter (misma cantidad de filas). Cada uno debe producir `RESTORE_DATA_DIVERGED`. Luego se revierten **solo esas fixtures CI** y se verifica paridad con el backup nuevamente. Traps de EXIT/INT/TERM intentan limpiar si algo falla. El ensayo nunca modifica la base restaurada.
- Se prueban además migraciones incompatibles, dispositivos offline desconocidos y lotes offline pendientes, aunque los bytes de la DB coincidan. Tests negativos de entrada, parámetros, permisos del archivo JSON y situaciones peligrosas.
- El CI previo y posterior al merge valida la evaluación, el ensayo de PostGIS, PostgreSQL/RLS, Chromium real, imágenes productivas y auditoría de dependencias. **El entorno de producción permanece fuera del alcance.**

## Formato de evidencia solo para revisión

La entrada `--evidence /ruta/absoluta/rollback-review.json` debe ser un JSON regular, privado (modo 0600), sin symlinks y de hasta 32 KiB. Campos requeridos:

```json
{
  "schema": "sedeagro-rollback-review-v1",
  "release": {
    "current_sha": "<SHA40 actual observado>",
    "target_sha": "<SHA40 previo aprobado>",
    "backup_sha256": "<SHA256 del archivo de respaldo>"
  },
  "database": {
    "live_fingerprint": "<tablas>|<secuencias>|<md5>",
    "backup_fingerprint": "<tablas>|<secuencias>|<md5>",
    "live_migrations": ["<lista real, ordenada y completa>"],
    "backup_migrations": ["<lista real, ordenada y completa>"],
    "target_code_migrations": ["<lista real del código destino, ordenada>"]
  },
  "operations": {
    "archive_sha256_verified": false,
    "writes_quiesced": false,
    "post_backup_writes_reconciled": false,
    "offline_devices_inventory_complete": false,
    "unknown_offline_devices": 1,
    "pending_offline_batches": 1
  }
}
```

Es **un esquema ilustrativo, no evidencia utilizable**: reemplazar la lista por las migraciones reales (más de 10 nombres; no placeholders) y las huellas generadas por procedimientos autorizados. El hash usado por el ensayo de CI es MD5 determinístico para detección de diferencias, **no protección contra un operador que falsifique evidencia**. Para entornos reales, la verificación de datos, integridad del archivo, timestamps, almacenamiento externo y roles exige una cadena de custodia independiente y resguardada. El script nunca genera ni certifica automáticamente esos testigos.

`node scripts/rollback-decision.mjs --evidence /ruta/privada/rollback-review.json` imprime solo estados/códigos, sin archivos, filas, secretos o rutas, y devuelve 2 ante evidencia inválida o caminos bloqueados; 0 solo si ambos caminos **requieren revisión humana**, no si son seguros. No conectar esta salida directamente a un botón de restaurar ni a `deploy-prod.sh`.

## Protocolo para eventual intervención en staging aislado

1. Congelar tráfico y escrituras de backend, report worker y procesos en segundo plano **realmente**; el `readiness` solo no detiene escrituras. Registrar el instante de corte, versión de aplicación, esquema, colas y clientes conectados.
2. Identificar los dispositivos físicos del piloto y **confirmar con cada responsable** el estado de borradores offline, evidencias cifradas, recibos `/sync/batches` e idempotency keys; si existe un equipo desconectado, la restauración queda bloqueada y se prepara reconciliación manual. Nunca borrar su IndexedDB para “hacer funcionar” un rollback.
3. Crear y preservar un backup **posterior al incidente** del estado actual antes de considerar otro backup anterior. Custodiar y probar ambos fuera de VPS en una instancia separada con roles y PostGIS, incluyendo operaciones recibidas desde el backup inicial.
4. Comparar contenido completo de tablas y secuencias, migraciones y compatibilidad de la API destino. Cualquier divergencia necesita **plan de recuperación hacia adelante o reconciliación explícita**, no restaurar por reflejo.
5. Ensayar en staging un rollback de imagen con el esquema vigente y verificar RLS, autenticación, órdenes, evidencias, reintentos y replay idempotente de dispositivos; registrar RTO/RPO reales.
6. Ejecutar la evaluación **como insumo de la revisión**, no como aprobación. Seguridad, datos y operación deciden GO/NO-GO por separado en #130, con plan de reversión y tratamiento de escrituras posteriores.

## Límites y próximas dependencias

- El ensayo de CI usa datos sintéticos; no certifica el rollback de un VPS, compatibilidad histórica real de binarios, estrategia point-in-time recovery (PITR), SLA de RPO/RTO ni ausencia de dispositivos offline desconocidos.
- Las listas de migraciones y las huellas no están firmadas por el validador; un JSON manipulado podría obtener `OPERATOR_REVIEW_REQUIRED`, que **no es autorización**. Para producción se requieren inventario derivado directamente de DB/artefacto identificado y verificación independiente.
- No se ejecutan migraciones `down`, `DROP DATABASE`, `pg_restore --dbname`, cambios en DNS, despliegues, restauraciones privadas ni borrado de datos.
- El siguiente paso de certificación es staging real aislado, compatibilidad de un SHA anterior real con esquema evolucionado, prueba de fallo durante corte y reconciliación de observaciones/evidencia hechas después del backup. #130 permanece **NO-GO** hasta aceptar todo el piloto.
