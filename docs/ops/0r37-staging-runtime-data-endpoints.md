# 0R.37 — Endpoints de datos y entorno real de staging OCI

**11/11/2026 · Piloto 0.1 · Release #130 continúa NO-GO.**

## Diferencia de seguridad identificada

`scripts/verify-staging-topology.mjs` comprueba el Compose de staging **antes de ejecutar servicios**: `REDIS_URL=redis://redis:6379`, credenciales de PostgreSQL para `sedeagro_staging_app`, origen HTTPS, DB `sedeagro_staging` y secretos separados.

En cambio, el inspector **posterior al arranque** `scripts/verify-staging-runtime.mjs` validaba el host/puerto/path/usuario del `DATABASE_URL` real, pero **no** el protocolo, contraseña, parámetros ni fragmento de esa URL. Tampoco comprobaba `REDIS_URL`. Un contenedor con `State.Health=healthy`, imagen OCI firmada y network/volúmenes correctamente etiquetados podía superar la revisión read-only aun si `REDIS_URL` apuntaba a Redis de producción, a un endpoint externo, una DB lógica diferente o si la URI del Postgres tenía opciones alteradas.

## Qué queda validado al inspeccionar el contenedor real

- `REDIS_URL` debe ser **exactamente** `redis://redis:6379`, sin credenciales, DB alternativa, parámetros, fragmento, puerto alternativo ni TLS/destino externo.
- `DATABASE_URL` exige protocolo `postgres:`, usuario `sedeagro_staging_app`, host `db`, puerto `5432` y ruta `/sedeagro_staging`, **sin** `?query` ni `#fragment`.
- La contraseña de DB debe tener formato y longitud compatibles con la admisión del Compose (24–512 caracteres, caracteres permitidos y sin marcadores obvios de ejemplo). `JWT_SECRET` también debe cumplir longitud/formato y ser distinto de la contraseña de DB. No se imprime ni persiste ninguno de esos valores.
- Se requieren `PORT=3001`, `LOG_LEVEL=info`, `LOG_FORMAT=json` además de los controles anteriores (`NODE_ENV=production`, `SEED_MODE=prod`, `LOG_SQL=0`, `LOG_STACK=0`, `BASE_DOMAIN`, `CORS_ORIGIN` y SHA completo).
- La comprobación corre tanto en **modo legacy** como en revisión OCI inmutable con doble inspección, sin modificar etiquetas, imágenes, red, base o Redis.

## Pruebas

```bash
node --check scripts/verify-staging-runtime.mjs
node --test scripts/test/staging-runtime.test.mjs
```

Los casos positivos representan el entorno real de Compose. Los negativos incluyen Redis de producción/externo, otro puerto o DB, URI alterada, credenciales embebidas, PostgreSQL externo, protocolo distinto, usuario propietario en vez del rol app, `sslmode=disable`, credenciales débiles/reutilizadas, modo debug y omisión de variables. El camino OCI firmado también rechaza el mismo desvío.

La CI `tenant-rls` ejecuta la suite en PR y merge; los jobs de navegador PostGIS/offline, imágenes, firma e importación OCI siguen siendo exigidos, independientemente de este cambio.

## Límites y autorización

Este gate analiza la configuración observada por Docker, **no** establece una conexión real a una DB física ni comprueba que el DNS interno no haya sido suplantado. La salud del servicio no reemplaza las pruebas de RLS con rol non-owner ni la inspección de red. No hay despliegue, migraciones, lectura de credenciales en consola, modificación de VPS o generación de firmas humanas.

Staging HTTPS de operador autorizado, restauración externa al VPS con RTO/RPO, pruebas físicas Android/iOS, aceptación de los seis actores y firmas de responsables siguen **NOT_RUN / BLOCKED**. **Producción: NO-GO.**
