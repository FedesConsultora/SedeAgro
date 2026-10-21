# 0P.23 — Recuperación independiente del mismo backup PostGIS, sin red (solo CI)

## Riesgo que existía

Los bloques 0P.3 y 0P.18 verifican que un `pg_dump --format=custom` es legible y que su restauración conserva filas de **todas** las tablas de aplicación, secuencias, catálogo, migraciones y FORCE RLS. El ensayo de 0P.18, sin embargo, restauraba en una *segunda base del mismo contenedor de PostGIS*, con las mismas extensiones, configuración de arranque y volumen del servidor de origen.

Un archivo puede parecer recuperable localmente y fallar al recuperarlo en otra instancia. Sin un ensayo adicional independiente, el procedimiento no demostraba portabilidad mínima del archivo ni que se pueda ejecutar la aplicación con un nuevo rol runtime. 0P.23 agrega una prueba CI **real** de recuperación en un segundo contenedor sin red, manteniendo los tests originales y sin acercarse a un VPS.

## Qué implementa

El runner original `scripts/ci-disposable-restore.sh` crea una copia privada temporal desde `sedeagro_test` de GitHub Actions y verifica paridad después de restaurarla en `sedeagro_restore_test`. Antes de continuar al ensayo de rollback 0P.21 y a la suite HTTP/RLS existente, ejecuta:

`scripts/ci-independent-recovery.sh --run`

El helper exige **cuatro** condiciones independientes de CI (`CI=true`, `GITHUB_ACTIONS=true`, la aceptación previa de bases de prueba descartables y `SEDEAGRO_INDEPENDENT_RECOVERY=I_ACCEPT_NETWORKLESS_CI_RECOVERY`). También comprueba:

- Identificador hex del contenedor de servicio original y etiqueta fija `postgis/postgis:16-3.4`. No recibe URLs de base, nombres arbitrarios de DB ni hosts externos.
- Archivo en ruta canónica `/tmp/` del runner con directorio y archivo privados, propietario actual, tamaño no trivial y SHA256 íntegro antes **y después** de la recuperación. Rechaza reemplazos/symlinks, directorios abiertos y digest incorrecto antes de tocar Docker.
- Huellas precomputadas de la base fuente (tablas, secuencias y digest de cada fila; catálogo y migraciones). Esos hashes son testigos **internos de CI**, no una firma de backup real de un cliente.

Cuando el helper pasa el preflight, arranca por `docker run --detach --rm --pull never --network none` una **segunda** instancia de PostGIS 16-3.4. No tiene conexión a `fedes-net`, la red productiva, el servicio PostgreSQL original, ni publicación TCP. Inicializa primero la base bootstrap fija `sedeagro_recovery_bootstrap`, que PostGIS prepara automáticamente con extensiones. **No restaura sobre esa base preconfigurada**: comprueba que no exista `sedeagro_restore_test` y crea exclusivamente ese destino desechable mediante `createdb --template=template0`, evitando colisiones de extensiones durante el restore. Utiliza un volumen Docker anónimo exclusivo, automáticamente descartado al destruir el contenedor. No se comparte ni monta el directorio de datos del servicio CI original; el archivo del host entra por `stdin` a `pg_restore`, y el acceso a la base recuperada se realiza exclusivamente con `docker exec`/socket local del contenedor.

Tras esperar readiness, el ensayo requiere las seis entidades esenciales del TOC y ejecuta:

1. `pg_restore --exit-on-error --no-owner --no-acl` sobre la **base nueva del contenedor nuevo**. No ejecuta un restore en la fuente.
2. Comparación completa del resultado de `scripts/sql/restore-data-fingerprint.sql`: número de tablas y secuencias, contenido de todas las filas de tablas `public` de aplicación, incluso cambios de igual cardinalidad, y último valor/estado de uso de cada secuencia.
3. Comparación separada del catálogo: huella ordenada de migraciones, total de migraciones, planes, cultivos y número de tablas con `RLS=ON` y `FORCE RLS=ON`.
4. Provisionamiento nuevo de `sedeagro_app` con `scripts/provision-runtime-role.sql` sobre la copia aislada, sin privilegios de propietario, superusuario, `BYPASSRLS`, `CREATEDB` ni `CREATEROLE`.
5. Prueba SQL real `scripts/sql/ci-independent-recovery-rls.sql` que crea dos tenants **sintéticos** y dos registros de heartbeat en una transacción que siempre hace `ROLLBACK`. Cambia efectivamente al rol `sedeagro_app`, exige `row_security_active`, cero registros sin tenant, visibilidad exclusiva por tenant A/B e incapacidad de modificar el heartbeat de B desde A. Las fixtures no se confirman.
6. Nueva comparación SHA256 del archivo fuente y limpieza del contenedor con `docker stop` y `--rm`. Si falla una sola comprobación, se detiene el gate de aceptación y no se declara recuperación exitosa.

Los resultados imprimen mensajes mínimos de aprobado/rechazado; no exponen datos de negocio, JWT, contraseñas, URLs privadas ni IDs de las filas restauradas. No se genera un archivo público con contenidos sensibles ni se persiste un volumen de staging.

## Limitaciones importantes

**Esto demuestra recuperación en una instancia PostgreSQL distinta, pero no en otro host físico**: ambos contenedores se ejecutan en el mismo runner descartable de GitHub. La imagen coincide con la versión de PostGIS del origen y NO valida actualización de versión mayor, collation de otro SO o compatibilidad de componentes externos.

La comparación MD5 interna sirve para detectar diferencias y regresiones; **no es una firma criptográfica de autenticidad de un backup privado**. El SQL necesita privilegio de superusuario sobre la base descartable para que RLS no oculte filas al calcular la huella. No ejecutarlo con un superusuario de staging ni producción.

El ensayo no verifica que exista un respaldo real conservado fuera del VPS, que pueda recuperarse un fallo físico de storage, que la clave de cifrado de un backup externo sea recuperable ni que existan credenciales/recursos alternativos operativos. Tampoco prueba el tiempo RTO/RPO real, el estado de otros sistemas/almacenes de archivos, ni la existencia o sincronización de teléfonos con observaciones offline (0P.21).

**Ningún componente del PR lee ni restaura backups privados reales.** La restauración SQL automática está bloqueada a GitHub Actions y al conjunto de bases CI descartables. El script no acepta URLs ni nombres productivos y no permite operar una instancia remota arbitraria.

## Próxima certificación real para la matriz #130

Una operación humana separada, autorizada y documentada deberá verificar en un **host o entorno de recuperación externo a la VM productiva** que se puede acceder a los bytes cifrados del archivo privado, confirmar su SHA256 bajo cadena de custodia y recuperar PostgreSQL/PostGIS con las mismas versiones y roles mínimos. Esa operación debe incluir catálogo, ACL/RLS, conteos y fingerprints íntegros sin registrar datos privados; debe medir RTO/RPO y prever el tratamiento de cambios posteriores al backup y de dispositivos offline (0P.21). El entorno debe permanecer segregado de producción y jamás restaurar sobre el servidor vivo.

**Criterio de código 0P.23:** cuatro jobs GitHub Actions en SUCCESS sobre el HEAD final de PR y de nuevo sobre el `main` resultante; en `tenant-rls`, ambos restores sintéticos, el SQL real de aislamiento entre dos tenants y la suite restaurada deben aprobar. Esto cierra **pruebas de código/CI**, no significa `GO` de producción ni certifica staging. #130 permanece NO-GO.
