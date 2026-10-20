# 0P.3 — Protección antes de migrar y prueba real de disponibilidad después del cutover

El deploy anterior reconstruía contenedores y aplicaba migraciones sin comprobar un respaldo específico ni el readiness de la API nueva. El bloque 0P.3 incorpora barreras *fail-closed* sin hacer ninguna operación automática sobre bases externas de staging/producción.

## Cambios

### Backup anterior a migraciones

Después de iniciar DB/Redis y **antes** de `npm run db:prepare`, `scripts/deploy-prod.sh` ejecuta `scripts/verify-production-backup.sh`. Es **solo lectura** y exige:

- `SEDEAGRO_RELEASE_SHA`: SHA completo ya aprobado por el preflight de 0P.1.
- `SEDEAGRO_VERIFIED_BACKUP_FILE`: archivo privado, regular, canonical y absoluto, fuera del repositorio, `/tmp`, `/var/tmp` y `/dev/shm`; propietario debe coincidir con el operador.
- `SEDEAGRO_VERIFIED_BACKUP_SHA256`: digest SHA-256 de 64 caracteres que coincida con los bytes actuales.
- `SEDEAGRO_RESTORE_APPROVAL=RESTORED:<SHA40>:<SHA256>`: declaración explícita de responsable **después de probar una restauración aislada** del archivo EXACTO. No es una firma criptográfica ni prueba automática de restore.
- Archivo con permisos 0600 (o más restrictivos), directorio 0700 (o más restrictivo), fecha de modificación de las últimas 24 horas y tamaño superior a 4 KiB.
- `docker compose exec -T db pg_restore --list` realmente capaz de abrir la TOC del backup; presencia de `sequelize_migrations`, `tenants`, `auth_sessions`, `fields`, `work_orders` y `evidence_blobs`.

**La creación, cifrado externo, copia y restauración del backup NO están automatizadas aquí.** Si no están hechas y documentadas, **no existe aprobación** y el deploy debe quedar bloqueado. El script no ejecuta `pg_dump`, `pg_restore --dbname`, migraciones, SQL de escritura, ni borra/crea bases.

### Health real después de recrear los servicios

Después de `docker compose up -d --no-deps backend frontend`, el deploy espera hasta 30 intentos para que desde el contenedor frontend el backend responda `/health/ready` con `ready:true`. Después exige que el Nginx interno sirva `/index.html` con éxito. Si alguno falla, termina en error y **no ejecuta una recarga voluntaria del proxy global ni anuncia éxito**.

**Limitación importante:** Compose reemplaza los contenedores en el mismo nombre y red; otros servicios pueden llegar a ellos incluso antes del check. Es una protección contra falso éxito, **NO** una actualización blue/green sin tiempo de inactividad y **NO** un rollback automático. Si el proceso falla tras migrar, un DBA debe coordinar recuperación, preservando escrituras posteriores al backup.

## Preparación operativa manual (NO ejecutada)

1. Validar en staging aislado el SHA exacto, seguridad de cookies, PostGIS/FORCE RLS con dos tenants, compatibilidad de migraciones y pilotos offline.
2. Con el usuario de migraciones, obtener un `pg_dump --format=custom --no-owner --no-acl` consistente de la base destino (sin pasar contraseña por CLI). Guardarlo bajo un directorio 0700 fuera de checkout y de directorios temporales, archivo 0600. No usar este bloque para crear dumps sin consentimiento y seguridad del entorno.
3. Calcular SHA256 del backup y copiarlo **cifrado** a almacenamiento externo según retención. Ensayar `pg_restore` del archivo exacto en instancia aislada, comparar migraciones, filas/tabla, RLS/FORCE RLS, evidencias y funcionamiento API. Registrar evidencia de restore, responsable y fecha; un `pg_restore --list` por sí solo no demuestra recuperación.
4. Revisar el SHA y CI posmerge; completar autorización de operación según 0P.1. En una intervención productiva formal, un ejemplo de entorno de ejecución, sin secretos:

```bash
export SEDEAGRO_RELEASE_SHA="<SHA40_VALIDADO>"
export SEDEAGRO_DEPLOY_APPROVAL="DEPLOY:$SEDEAGRO_RELEASE_SHA"
export SEDEAGRO_VERIFIED_BACKUP_FILE="/srv/backups/sedeagro/pre-release.dump"
export SEDEAGRO_VERIFIED_BACKUP_SHA256="<SHA256_VALIDADO>"
export SEDEAGRO_RESTORE_APPROVAL="RESTORED:$SEDEAGRO_RELEASE_SHA:$SEDEAGRO_VERIFIED_BACKUP_SHA256"
# Ejecutar deploy-prod.sh solo con ventana autorizada, staging y rollback aprobados.
```

5. Tras el deploy controlado, verificar por HTTPS desde fuera: `/health/ready`, headers TLS/HSTS, `/api/v1/auth/me` anónimo 401, SHA/asset-manifest del frontend, RLS, permisos y dos tenants. Registrar observabilidad durante la ventana y criterios de stop.

## Tests y clasificación

`node --test scripts/test/production-backup-guards.test.mjs` usa archivos sintéticos, directorios privados y un ejecutable Docker **simulado**, sin bases, contenedores o VPS. Comprueba aprobación, SHA, rutas/symlinks, permisos, antigüedad, checksum, rechazo ante `pg_restore` fallido y TOC incompleta. CI conserva un ensayo **real** de pg_dump/pg_restore de PostGIS desechable a través de `scripts/ci-disposable-restore.sh`, no sobre la instalación de campo.

Para la primera versión productiva siguen pendientes: pruebas reales en staging del backup/restauración, ejecución remota, QA Android/iOS, accesibilidad #86, rendimiento #105, rollback, firma de go/no-go y estrategia de corte sin pérdida de operaciones. Nada de lo anterior queda certificado por un PR verde.
