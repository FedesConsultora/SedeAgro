# 0P.1 — Gate previo al despliegue de SedeAgro (solo lectura)

**Alcance:** este bloque agrega una barrera *fail-closed* que se ejecuta en el host **antes de construir contenedores o ejecutar migraciones**. No publica una versión, no verifica un VPS real y no certifica restauración. El estado inicial de este trabajo es `main` b820b57d4723518943c06f24151e3b5e02eb8b29. El SHA de liberación es siempre el que se apruebe *después* del PR y del CI posmerge.

## Qué rechaza el preflight

- SHA incompleto, inválido o diferente del HEAD local y de `refs/remotes/origin/main`.
- Falta de aprobación nominal `SEDEAGRO_DEPLOY_APPROVAL=DEPLOY:<SHA40>`, branch distinta de `main`, HEAD detached y cambios tracked pendientes.
- Archivos de entorno faltantes, symlinks o permisos accesibles por grupo/otros (se requiere `chmod 600 .env backend/.env`).
- `backend/.env` con `NODE_ENV` distinto de `production`, `SEED_MODE` distinto de `prod`, `LOG_SQL` o `LOG_STACK` distintos de `0`.
- `BASE_DOMAIN` distinto de `sedeagro.fedes.ai` o `CORS_ORIGIN` distinto de `https://sedeagro.fedes.ai`. La política es explícitamente de **producción**, no de entornos de staging.
- JWT insuficiente o placeholder; roles owner/runtime iguales; credenciales owner/runtime cortas, con metacaracteres no permitidos o placeholders.
- Variables críticas duplicadas. Solo acepta `KEY=value` simple, sin comillas ni interpolación para estas variables. No carga ni evalúa los contenidos de los `.env`.

El desplegador primero verifica branch limpia y deshabilita `SKIP_GIT_PULL`, luego ejecuta `git pull --ff-only origin main`, y **antes de Docker** llama al preflight. Si el código remoto cambió respecto al SHA que se aprobó, falla. La salida no muestra contraseñas, JWT ni valores de conexión.

## Ejecución de solo lectura, sin desplegar

Con el checkout limpio de `main`, `.env` y `backend/.env` seguros:

```bash
git fetch origin main
SHA="$(git rev-parse refs/remotes/origin/main)"
# Solo después de revisar el SHA, los dos jobs CI y la ventana de cambio:
SEDEAGRO_RELEASE_SHA="$SHA" \
  SEDEAGRO_DEPLOY_APPROVAL="DEPLOY:$SHA" \
  bash scripts/production-preflight.sh
```

El resultado `PASS` indica únicamente que el entorno y la identidad de código pasaron verificaciones estáticas y de Git. **No ejecutar `deploy-prod.sh` como consecuencia automática de PASS**: faltan los gates operativos siguientes.

Cuando exista autorización separada para el despliegue, el mismo par de variables deberá estar presente para ejecutar `scripts/deploy-prod.sh`. El deploy no incluye una excepción para saltar `git pull`.

## Pruebas automáticas

`node --test scripts/test/production-preflight.test.mjs` crea en directorios temporales un repositorio Git real, un bare remoto local y archivos de entorno sintéticos. Comprueba el caso válido y rechaza: SHA/aprobación incorrectos, branch no principal, HEAD detached, worktree sucio, divergencia del remoto, permisos inseguros, secretos débiles, semilla demo, logs SQL/stack abiertos, origen incorrecto, roles iguales, duplicados e interpolación maliciosa. **Nunca conecta con un VPS, Docker, PostgreSQL ni datos reales**. GitHub Actions ejecuta estas pruebas junto a la suite original de aislamiento.

## Puertas todavía obligatorias antes de producción

1. Ensayo de staging con SHA y assets publicados comparados contra artefactos de CI (`docs/ops/0t3-staging-release-gates.md`).
2. Backup **previo a migraciones** con checksum, almacenamiento externo protegido y restauración efectivamente probada sobre instancia aislada (`docs/ops/0t4-disposable-restore.md` documenta solo el ensayo de CI).
3. Readiness de backend contra la base real con usuario runtime, proxy TLS/HSTS, cookies seguras, pruebas de RLS y dos empresas sin acceso cruzado.
4. Aceptación rural en Android/iOS reales (offline, IndexedDB, cámara, sincronización, reintentos y revocación) y QA de accesibilidad.
5. Benchmark de filtros globales, issue #105, e investigación de foco Chromium, issue #86.
6. Plan de reversión y conciliación de cambios posteriores al backup con responsables identificados. No restaurar o borrar operaciones reales automáticamente.

**Clasificación:** código candidato a producción con gate más estricto, **no** certificación de release ni autorización para intervenir el VPS.
