# SedeAgro 0.1 — Transporte seguro de configuración de BD en el despliegue

**Bloque 0R.11 · Coordinación #18 · Release #130 NO-GO**

## Riesgo real identificado en fuente

El script heredado `scripts/deploy-prod.sh` invocaba `source .env`. A diferencia del parser de `scripts/production-preflight.sh`, `source` **ejecuta código Bash** contenido en el archivo, incluyendo `$(...)`, sustituciones y funciones arbitrarias. Aunque el preflight exige `.env` privado, leer configuración como código ejecutable no es una frontera adecuada para producción.

Adicionalmente, pasaba `POSTGRES_PASSWORD` mediante `docker compose run -e MIGRATION_DB_PASSWORD=<secreto>` y `APP_DB_PASSWORD` mediante `psql -v app_password=<secreto>`. La línea de comandos del proceso puede resultar accesible a procesos con permisos de inspección del host. No hay evidencia de exposición efectiva; sí una vía innecesaria de revelación. El riesgo de logs SQL, entorno de procesos y acceso privilegiado al host sigue existiendo.

## Cambio limitado a código; sin ejecución de deploy

1. `scripts/production-env-loader.sh` es un parser **confiable y versionado en el mismo SHA**. No ejecuta `.env` ni evalúa contenido. Lee sólo `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `APP_DB_USER`, `APP_DB_PASSWORD`. Exige un único valor por clave, tamaño de archivo acotado, nombres DB/roles válidos y contraseñas URL-safe de al menos 24 caracteres, sin marcadores típicos de ejemplos. Rechaza CR, duplicados, symlinks y trazas Bash `xtrace`. No imprime contraseñas.
2. `deploy-prod.sh` incorpora el parser **después** del preflight que ya revisa SHA exacto, admisión OCI/seguridad, Git limpio y permisos. No modifica la etapa de autorización, el bloqueo del host, la política de firma ni el hard-stop existente del despliegue.
3. La contraseña del dueño de DB se entrega a `docker compose run` como variable heredada exclusivamente para el proceso, solicitada con `-e MIGRATION_DB_PASSWORD` **sin valor en argv**; la variable no se exporta al resto de la shell.
4. El rol de aplicación recibe `app_password` mediante la entrada estándar de `psql`, antes de `scripts/provision-runtime-role.sql` versionado, nunca mediante `-v app_password=...`. El parser garantiza que el valor no contenga separadores, comillas, saltos de línea ni comandos del cliente `psql`. El aprovisionamiento sigue usando el owner y el SQL que concede permisos mínimos.
5. El script apaga `xtrace` antes de leer secretos. El nuevo gate de Node ejecuta Bash real con archivos sintéticos y sin Docker, y demuestra que texto hostil no se ejecuta, que la contraseña no se imprime, que el parser falla ante archivos inseguros y que el script de producción mantiene el preflight/denegación actual.

## Validación y límite

- Prueba local/CI: `node --test scripts/test/production-env-loader.test.mjs`.
- Verificación de sintaxis: `bash -n scripts/deploy-prod.sh scripts/production-env-loader.sh`.
- La CI de la PR debe terminar sobre su HEAD exacto y repetirse tras merge en `main`.
- No se ejecutó Docker real ni se migró base. No se modificaron usuarios, credenciales, PostgreSQL, backend, frontend, datos, staging, VPS ni producción.
- No se afirma que variables del entorno sean invisibles a root/operadores del proceso. No se modifican `scripts/production-preflight.sh` ni los requisitos de firmas externas; la política OCI firmada sigue bloqueando el release sin aprobación.
- **Antes de operación real**, Security/Operations deben confirmar permisos de procesos, `docker compose config` sin exposición a logs, roles RLS, un restore privado aprobado y una promoción OCI sin rebuild. Todavía existen el build de imágenes in situ y barreras de aceptación externa: release #130 **NO-GO**.

## Reversión

Revertir la PR restaura el comportamiento anterior, pero **no es seguro recomendar ese rollback para un servidor real** por el riesgo de `source .env` y secretos por argv. Si falla la carga de parámetros, detener el despliegue; corregir la configuración validada y someter una reparación a revisión.
