# 0R.45 — Revisión de recuperación externa: RTO/RPO y rollback

**11/11/2026 · Piloto 0.1 · Release #130: NO-GO.**

## Brecha
0P.18, 0P.21 y 0P.23 acreditan recuperación de PostgreSQL/PostGIS **dentro de CI descartable**, nunca una recuperación tras perder el VPS y su almacenamiento. La prueba 0R.43 acredita recuperación del proceso del worker, tampoco disponibilidad externa de datos.

Este bloque crea un revisor read-only de hechos suministrados por un operador: **scripts/external-recovery-review.mjs**. Calcula RTO, RPO, tiempo PostgreSQL y rollback desde timestamps UTC. Rechaza anomalías y exige inventario de datos y dispositivos. **No realiza el restore, no firma ni certifica evidencia, no ejecuta operaciones remotas.** Aun con datos coherentes su salida máxima es OPERATOR_REVIEW_REQUIRED, no GO.

## Procedimiento real pendiente — requiere autorización explícita

1. Aprobar un ensayo de recuperación en un host separado del VPS de producción, con almacenamiento de backup externo y segregado. Resguardar cadena de custodia firmada, sin dar conectividad del host restaurado al tráfico vivo.
2. Identificar SHA40 de release, SHA256 del archivo y bytes recuperados, PostGIS por digest de imagen inmutable, y huellas SHA256 de host fuente, host recuperador y storage externo. Las tres huellas distintas son necesarias pero **no prueban independencia física**: validar inventario de infraestructura por separado.
3. Restaurar **el archivo exacto** en PostGIS nuevo aprobado, nunca sobre base viva. Revisar exit code y versión, migraciones completas, huellas de todas las filas/secuencias, FORCE RLS, lectura runtime A/B non-owner, API autenticada y archivos privados.
4. Tomar tiempos con relojes UTC sincronizados: último commit consistente cubierto por backup, inicio de indisponibilidad, inicio del restore, PostgreSQL listo, API funcional, inicio y final del ensayo de rollback. Un simple HTTP 200 de liveness no demuestra recuperación.
5. Preservar escrituras posteriores al backup y reconciliar recibos offline, colas e inventario físico. Cualquier dispositivo desconocido o batch pendiente impide superar el revisor.
6. Registrar los hechos **sin datos privados, credenciales, nombres de host, IP ni rutas** en JSON 0600 bajo directorio 0700, fuera de Git y CI público. Ejecutar el revisor y someter el log original de operaciones a revisión independiente de Security, Operations, Data y Product.

## Esquema obligatorio v1

El objeto raíz tiene exactamente cinco propiedades: **schema, release, placement, timeline, checks**.

- schema: sedeagro-external-recovery-review-v1
- release: head_sha (40 hex), backup_sha256, recovered_archive_sha256 (ambos 64 hex e idénticos), source_postgis_image y recovery_postgis_image (ambos sha256: + 64 hex e idénticos).
- placement: source_host_fingerprint, recovery_host_fingerprint, backup_store_fingerprint (tres SHA256 distintos).
- timeline: backup_consistent_until_at, outage_started_at, restore_started_at, postgres_ready_at, api_ready_at, rollback_started_at, rollback_ready_at. Cada uno es ISO UTC canónico YYYY-MM-DDTHH:mm:ss.sssZ y debe respetar el orden causal.
- checks: doce booleanos explícitos más pending_offline_batches y unknown_offline_devices (enteros >= 0, deben ser cero).

Los doce booleanos deben ser **true**, y requieren evidencia documental independiente:

| Campo de checks | Comprobación operativa |
|---|---|
| utc_clocks_synced | Relojes y logs de una referencia UTC común |
| archive_hash_verified | SHA256 calculado desde bytes recuperados |
| restore_command_succeeded | Restore efectivo sobre host separado |
| migrations_equal | Esquema y migraciones reconciliados |
| row_and_sequence_fingerprints_equal | Huellas completas de filas/secuencias |
| force_rls_verified | FORCE RLS activo después de restaurar |
| two_tenant_denial_verified | Rol runtime A no observa B |
| private_evidence_verified | Multimedia privada recuperada y restringida |
| application_authenticated_read_verified | API autenticada contra DB recuperada |
| restored_state_isolated | Sin operaciones sobre la base fuente |
| post_backup_writes_reconciled | Escrituras posbackup no descartadas |
| offline_device_inventory_complete | Todos los dispositivos offline inventariados |

El formato rechaza campos desconocidos, URLs, rutas y secretos añadidos como metadatos. El archivo JSON local debe ser regular, canónico, privado, propiedad del operador y menor a 64 KiB.

## Métricas derivadas, no declaradas

- **RPO (s)** = outage_started_at menos backup_consistent_until_at. Es una ventana potencial de pérdida; no verifica por sí sola todos los commits o dispositivos.
- **RTO (s)** = api_ready_at menos outage_started_at. Incluye interrupción, restauración y verificación auténtica de API.
- **Restore PostGIS (s)** = postgres_ready_at menos restore_started_at.
- **Rollback (s)** = rollback_ready_at menos rollback_started_at.

No hay SLO RTO/RPO firmado en el alcance actual, por lo tanto **no se declara cumplimiento de SLA** con estos números. La herramienta verifica consistencia del registro, no su veracidad ni su origen. El JSON puede falsificarse: firmas independientes y evidencia del host deben revisarse por fuera.

## Validaciones automáticas

~~~~bash
node --check scripts/external-recovery-review.mjs
node --test scripts/test/external-recovery-review.test.mjs
node scripts/external-recovery-review.mjs --evidence /ruta/privada/recovery-review.json
~~~~

La CLI devuelve código 2 ante evidencia inválida/bloqueada; código 0 significa **solo OPERATOR_REVIEW_REQUIRED**. Sus mensajes no incluyen secrets, digests, host IDs ni rutas privadas. El gate tenant-rls ejecuta los tests sintéticos en PR y main.

**Fuera de alcance:** staging autorizado en la red real, backup real fuera de la VM, descifrado custodio, pérdida de host, PITR, sincronización física Android/iOS, firma de responsables, umbrales SLA y despliegue productivo. Nada en este bloque modifica Docker, VPS o DB real; **release #130 permanece NO-GO**.
