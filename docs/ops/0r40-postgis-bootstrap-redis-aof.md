# 0R.40 — Bootstrap PostGIS y persistencia Redis efectivos en staging

**11/11/2026 · Piloto SedeAgro 0.1 · Release #130: NO-GO.**

## Hallazgo real

El validador de Compose exigía el nombre y propietario del PostgreSQL privado, pero no impedía que se agregaran variables de bootstrap que debilitan la autenticación como `POSTGRES_HOST_AUTH_METHOD=trust`, `POSTGRES_INITDB_ARGS=--auth-host=trust` o un `POSTGRES_PASSWORD_FILE` de otra ubicación. También omitía comprobar el comando de Redis: `redis-server --appendonly no` podía conservar un healthcheck `PING` correcto sin persistencia AOF.

Después de crear los contenedores, `verify-staging-runtime.mjs` comprobaba la URL del backend y los IDs/red/volúmenes, pero no los valores `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` del contenedor PostGIS ni el `Config.Cmd` de Redis. En consecuencia, los checks de identidad y salud no detectaban desvíos de bootstrap/autenticación o persistencia.

## Bloqueos nuevos

1. **Antes del arranque** (`verify-staging-topology.mjs`): el Compose de PostGIS solo puede definir `POSTGRES_DB`, `POSTGRES_USER` y `POSTGRES_PASSWORD` seguros; variables adicionales de bootstrap quedan bloqueadas. Redis debe conservar exactamente el comando array `['redis-server','--appendonly','yes']`, sin parámetros inyectados ni variables de entorno de servicio adicionales.
2. **Después del arranque** (`verify-staging-runtime.mjs`): el contenedor de PostGIS debe declarar `POSTGRES_DB=sedeagro_staging`, `POSTGRES_USER=sedeagro_staging_owner` y una contraseña privada en formato aprobado. Se prohíben `POSTGRES_HOST_AUTH_METHOD`, `POSTGRES_INITDB_ARGS` y `POSTGRES_PASSWORD_FILE`.
3. Las tres credenciales sensibles (contraseña propietaria PostGIS, contraseña del usuario app PostgreSQL, firma JWT) deben ser **distintas** y tener mínimos de formato y longitud. La validación jamás imprime ni devuelve esos valores.
4. El comando configurado de Redis debe ser exactamente `redis-server --appendonly yes`. Los cuatro contenedores continúan sometidos a los controles previos de red interna, bindings efectivos, imágenes OCI fijadas, volúmenes y salud.

## Pruebas adversariales

```bash
node --check scripts/verify-staging-topology.mjs
node --check scripts/verify-staging-runtime.mjs
node --test scripts/test/staging-topology.test.mjs scripts/test/staging-runtime.test.mjs
```

Incluye negativas de autenticación `trust`, argumentos de `initdb`, contraseña de archivo, rol/DB ajenos, secretos iguales o débiles, comando Redis sin AOF, con flags extra, o sustituido por shell. El flujo OCI firmado pasa por el mismo validador real y rechaza configuraciones inseguras.

## Alcance limitado

Esto evalúa la **configuración observada** por Docker, no el estado de `pg_hba.conf` dentro de una base restaurada, el valor vivo de `appendonly` consultado con `redis-cli CONFIG GET`, ni el proceso efectivo frente a un host comprometido. No se realiza `docker exec`, no se modifica Redis/PostGIS y no hay acceso a VPS, secretos, contenedores o datos de producción. La restauración externa y la certificación de staging requieren validación independiente del operador.

**Release #130 continúa NO-GO:** faltan HTTPS staging autorizado, restore off-VPS y rollback/RTO/RPO medidos, aceptación Android/iOS física, seis actores y firmas humanas Seguridad/Operaciones/Datos/Producto.
