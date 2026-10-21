# 0P.22 — Topología y procedencia de staging aislado (sin despliegue)

## Brecha P0 identificada

El `docker-compose.yml` habitual tiene `name: sedeagro`, contenedores con
`container_name: sedeagro_*`, red interna con nombre fijo `sedeagro_internal`,
volúmenes permanentes y un `fedes-net` externo. **No se debe ejecutar ese
Compose para preparar un staging en un VPS compartido**: puede coincidir con
nombres/volúmenes/rutas de producción, incluso usando un archivo de overrides.

0P.22 crea una especificación **independiente** `docker-compose.staging.yml`,
sin heredar servicios, nombres, redes, credenciales, volúmenes o certificados
productivos. Su inclusión en el repositorio NO la ejecuta.

## Diseño y contratos seguros

- Proyecto Compose exclusivo: `sedeagro-staging`, sin `container_name`. Red
  exclusiva `sedeagro-staging_staging_internal` con `internal: true`; ninguna
  conexión a `fedes-net`, `sedeagro_internal` o al backend productivo.
- Volúmenes exclusivos: `sedeagro-staging_staging_pgdata` y
  `sedeagro-staging_staging_redisdata`. Ni los nombres ni sus datos se
  comparten con producción. Los servicios PostgreSQL, Redis y backend NO
  publican puertos del host.
- Frontend Nginx publica **solo** `127.0.0.1:4183:80`. Un operador puede
  conectarlo DESPUÉS a un proxy TLS exclusivo aprobado, nunca por una
  publicación `0.0.0.0`. No toca `sedeagro.fedes.ai.conf`, certificados,
  DNS ni reglas del proxy global. La red interna impide que el backend tenga
  salida externa; cualquier integración externa requerirá revisión independiente.
- Alias `sedeagro_backend` exclusivamente en esa red aislada porque el
  `frontend/nginx.conf` ya requiere ese nombre para hacer proxy de
  `/api` y `/health`. Se reutilizan las Dockerfiles de producción: misma
  implementación, sin fallback mock, release SHA40 exigido para ambos builds.
- DB fija `sedeagro_staging`, owner `sedeagro_staging_owner`, rol de
  aplicación `sedeagro_staging_app`; contraseñas de owner/runtime únicas y
  JWT staging único. El backend siempre corre `NODE_ENV=production`,
  `SEED_MODE=prod`, SQL/stack logs deshabilitados; CORS solo HTTPS del
  dominio de staging. No `env_file` ni carga automática de `backend/.env`.
- No se ejecutan migraciones, rol provisioning, seeds, workers opt-in,
  restauraciones ni comandos de `up` desde estos verificadores. Antes de
  iniciar el backend, una ejecución aislada, formalmente autorizada,
  debería provisionar esquema y rol runtime en la **DB exclusiva de staging**.

## CI real: inspección pre-arranque

El job `production-images` ejecuta el CLI real de Docker Compose sobre el
archivo independiente con valores sintéticos de CI, leyendo deliberadamente
`--env-file /dev/null` para NO tomar `.env` de producción:

```bash
docker compose --env-file /dev/null -f docker-compose.staging.yml config --format json |
  node scripts/verify-staging-topology.mjs --sha "$SEDEAGRO_STAGING_SHA" \
    --host "$SEDEAGRO_STAGING_HOST"
```

**La salida sin filtrar de `docker compose config` contiene secretos y no
debe imprimirse, subirse a issues ni conservarse en logs.** El validador acepta
solo el JSON resuelto desde stdin (hasta 256 KiB), valida los cuatro servicios,
nombre del proyecto, redes, volúmenes, backend, rol/host DB, políticas de
publicación, redirección interna, JWT no reutilizado dentro del propio stack,
CORS y SHA exacto de ambos builds. Se niega a imprimir secretos incluso ante
JSON roto. El estado favorable es `CONFIG_REVIEW_REQUIRED`, **no** una
certificación runtime o producción.

Para un entorno real, las cinco variables requeridas deben provenir de un
almacén seguro y ser distintas de las productivas:

| Variable | Propósito |
| --- | --- |
| `SEDEAGRO_STAGING_SHA` | SHA Git completo que identifica ambas imágenes |
| `SEDEAGRO_STAGING_HOST` | Host público de staging, p. ej. `staging.sedeagro.fedes.ai` (ejemplo, no DNS confirmado) |
| `SEDEAGRO_STAGING_OWNER_PASSWORD` | Credencial exclusiva del owner DB de staging |
| `SEDEAGRO_STAGING_APP_PASSWORD` | Credencial exclusiva del rol runtime DB (distinto del owner) |
| `SEDEAGRO_STAGING_JWT_SECRET` | Clave JWT exclusiva de staging |

Los secretos deben tener caracteres seguros para URL y longitud suficiente;
nunca pasarlos por la línea de comandos ni reutilizar los de producción.
`--env-file /dev/null` no impide que Docker Compose vea estas variables de
entorno explícitas; sí evita fuentes dotenv implícitas.

## Inspección runtime read-only, solo después de aprobación independiente

`scripts/verify-staging-runtime.mjs` usa **únicamente**
`docker container ls --all --filter label=com.docker.compose.project=sedeagro-staging`
y `docker inspect`, nunca `up`, `down`, `restart`, `exec`,
`pg_restore`, SQL ni mutaciones de host.

Tras tener un staging activado por un operador autorizado, puede usarse:

```bash
node scripts/verify-staging-runtime.mjs \
  --sha "<SHA40 exacto de la release instalada>" \
  --host "staging.sedeagro.fedes.ai"
```

El resultado verifica que exista un solo contenedor por servicio; que estén
`running` y `healthy`, sin reinicios; que los cuatro pertenezcan al proyecto
`sedeagro-staging` y a su única red interna; que los volúmenes y publicaciones
de puertos estén separados; y que frontend/backend tengan el **tag y label OCI
de revisión** correspondiente al SHA exacto. Registra IDs de imagen Docker
locales `sha256:…`, no valores de `Config.Env`.

**Limitación crítica:** el SHA de un label OCI y el identificador de imagen
local no sustituyen un digest inmutable de imagen en un registry ni una firma de
supply chain. Este bloque NO prueba que los bytes de una imagen instalada
coincidan con un artefacto remoto de confianza. Para un GO real, comparar los
digest registrados por el pipeline/registry y la procedencia del artefacto
instalado con evidencia conservada independientemente.

Un resultado positivo es `RUNTIME_REVIEW_REQUIRED`, con flags explícitos
`registry_digest_certified:false`, `tls_certified:false` y
`database_isolation_certified:false`. Requiere observación separada del
endpoint HTTPS y `verify-pilot-staging.sh` con el SHA correcto, más
`verify-deployed-staging.mjs` y el manifest del CI para el frontend.

## Requisitos previos para activar staging por fuera de este PR

1. Autorización explícita de responsable de seguridad/datos/infra, hostname
   distinto de producción, certificado TLS válido y redirección/edge proxy
   exclusivo sin modificar las rutas productivas.
2. Revisar que el VPS tenga espacio y CPU libres, y que no haya otro proyecto
   Compose usando puertos/volúmenes; auditar con cuidado los secretos y su
   custodia. No ejecutar `docker compose -f docker-compose.yml ...` para
   staging. Solo archivo único `docker-compose.staging.yml`.
3. Verificar una DB nueva `sedeagro_staging` antes de migrar: instalación
   inicial limpia, permisos mínimos y `FORCE RLS`. Si contiene datos previos,
   realizar backup privado y restore aislado según #130; no reusar el
   `FIRST_DEPLOY` de producción. No habilitar cuentas demo en el piloto.
4. Implementar el proxy TLS con una aprobación independiente, luego correr el
   smoke real HTTPS y comparar frontend hash con release manifest confiable.
   Verificar `401/403/404`, cookies, CSRF, two-tenant RLS, roles runtime,
   evidencias, sync offline, worker por tenant si aplica.
5. Ensayar rollback de imagen preservando datos posteriores al backup (0P.21),
   recuperación fuera del VPS, tiempos RPO/RTO, fallos del backend y
   teléfonos Android/iOS físicos con conexión intermitente.
6. Registrar digest de imagen OCI de origen, ID local, SHA de release, CI exacto,
   URL HTTPS, evidencia TLS, responsables, ventana y decisión en #130.

## Qué se verificó y qué NO

**Sí en CI:** parser real `docker compose config --format json` con variables
sintéticas, compilación Dockerfiles backend/frontend sobre SHA exacto, pruebas
de topologías maliciosas, y pruebas de inspección de contenedores simulados.
Los cuatro jobs habituales deben aprobar sobre HEAD PR y main postmerge.

**No:** despliegue real, arranque Compose con DB migrada, emisión/validación de
certificado público, verificación real de DNS, tráfico desde teléfonos,
digest registry independiente, backup de datos reales ni readiness de staging.
Ninguna marca de verificación del issue #130 se certifica con este PR.
**El GO/NO-GO global permanece NO-GO.**
