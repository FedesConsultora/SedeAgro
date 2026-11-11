# 0R.33 — Backup: no aceptar inspección sobre el proyecto Docker equivocado

**11/11/2026 · SedeAgro 0.1 · Release #130: NO-GO.**

## Brecha concreta

El gate de solo lectura `scripts/verify-production-backup.sh` cotejaba SHA256, frescura, permisos y seis tablas críticas de un `pg_dump` suministrado por el operador. La estructura del archivo se inspeccionaba mediante `docker compose exec -T db pg_restore --list`, **sin fijar archivo, directorio ni proyecto Compose**. Ejecutado por separado, un directorio de trabajo arbitrario, `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME` o un daemon remoto heredado podían producir un resultado aparentemente satisfactorio contra otro `db`.

Esta PR corrige la ambigüedad, **sin realizar una restauración ni actuar sobre una base**.

## Contrato nuevo de verificación

1. Rechazar de inmediato overrides `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `DOCKER_CONFIG`, `DOCKER_DEFAULT_PLATFORM`, `BUILDX_BUILDER` y toda la familia `COMPOSE_*` usada para redirigir proyectos, profiles y env-files.
2. El gate exige un `docker-compose.yml` local no enlazado y ejecuta únicamente `docker compose --project-directory <checkout> --file <checkout>/docker-compose.yml --project-name sedeagro`, independientemente del `cwd` externo.
3. `compose ps --quiet db` debe devolver **un único ID hex de 64 bytes**. `docker inspect` comprueba que ese ID corresponda al contenedor `/sedeagro_db`, etiquetas `com.docker.compose.project=sedeagro`, `service=db`, imagen PostGIS 16-3.4 con digest fijado, `Running=true` y `Health=healthy`.
4. Se inspecciona el índice del backup mediante `pg_restore --list` en ese servicio exacto; luego se repite la identidad del contenedor y el SHA256 del archivo, rechazando sustituciones o alteraciones detectables durante la operación.
5. Se mantienen el control de frescura de 24 h, permisos privados, firma humana declarada por el operador (que **no** equivale a firma criptográfica) y las seis definiciones de tablas públicas.

Se redactan los errores: no imprimir secretos, `docker inspect`, variables ni contenido del archivo.

## Evidencia automatizada

```bash
bash -n scripts/verify-production-backup.sh
node --test scripts/test/production-backup-guards.test.mjs
```

Los tests usan solamente un Docker simulado y un `pg_dump` sintético. Rechazan proyectos remotos, contextos y Compose heredados, suplantación de nombre/proyecto/servicio/imagen/salud de PostGIS, cambio del ID entre dos lecturas, digest alterado mientras se lista el TOC, tablas ausentes y comentarios fraudulentos.

`tenant-rls` corre estas pruebas en CI; los jobs de producción (imágenes/Syft/Trivy/OCI) y Chromium se ejecutan por separado. **No se toca un servidor productivo o de staging**, ni se ejecuta `pg_restore` contra una base de datos.

## Límites: no es una certificación de restore

Un contenedor correctamente identificado no demuestra que la copia cifrada exista fuera del VPS, que se haya restaurado en otro host, ni que se hayan medido RTO/RPO. Tampoco prueba continuidad de datos offline en dispositivos, compatibilidad de migraciones de rollback ni corta una carrera iniciada después de la última lectura de identidad. El paso requiere aún aprobación humana firmada de Seguridad, Operaciones, Datos y Producto y un ensayo independiente real de restore.

**El gate de release #130 permanece NO-GO.**
