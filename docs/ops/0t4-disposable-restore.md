# Bloque 0T.4 — Ensayo de backup y restauración de PostGIS en CI

**Estado de entorno:** ensayo automatizado en dos bases descartables, nunca sobre staging real ni producción. Es un gate técnico adicional para acercar SedeAgro a la preparación de piloto; **no significa que una restauración real esté aprobada**.

## Contrato implementado

`scripts/ci-disposable-restore.sh` solo ejecuta operaciones si el proceso está en GitHub Actions, `CI=true`, el operador autoriza exactamente `SEDEAGRO_DISPOSABLE_RESTORE=I_ACCEPT_ONLY_CI_TEST_DATABASES`, el ID es hexadecimal válido y la imagen Docker coincide con `postgis/postgis:16-3.4`.

Los nombres de origen, destino y roles son **constantes en el script**:
- `sedeagro_test`, ya migrada por CI: se trata solo como **origen de lectura** para el dump
- `sedeagro_restore_test`, que debe **no existir** antes del ensayo: se crea y elimina exclusivamente dentro de CI
- Usuario propietario `sedeagro_owner` para el ensayo; `sedeagro_app` con permisos mínimos para las pruebas de APIs

No acepta URLs, flags arbitrarios de PostgreSQL, nombres de bases, host de VPS, ni ruta de backup. También admite `--check-only` para comprobar guardas sin tocar contenedores. Esta modalidad es la única que se usa en los tests Node.

## Recorrido efectivo del gate

1. Comprueba presencia de migraciones, semillas globales, suficientes tablas tenant con RLS y **FORCE RLS para todas las RLS activadas**. El destino debe estar ausente.
2. Genera `pg_dump -Fc --no-owner --no-acl` desde la base origen a un archivo temporal con `umask 077`. Abre la lista con `pg_restore --list`, exige objetos críticos de sesiones, catálogo, credenciales y evidencia, y calcula SHA-256 (el dump no se sube como artefacto).
3. Crea la nueva base descartable `sedeagro_restore_test` y ejecuta `pg_restore --exit-on-error --no-owner --no-acl`.
4. Compara huella de migraciones, cantidad de semillas y cantidad de tablas RLS/FORCE RLS entre las dos bases. Un backup cuyo contenido no coincide **bloquea** el gate.
5. Provisiona permisos mínimos del rol runtime sobre la restaurada. Ejecuta las pruebas de integración de API/PostGIS/RLS con `TEST_DATABASE_ADMIN_URL` y `TEST_DATABASE_APP_URL` de la base restaurada. Se conservan los casos reales de dos tenants, seguridad de sesiones, cookie/CSRF, GIS, observaciones y evidencia.
6. Incluso ante fallo o señal de terminación, elimina el dump privado y solicita borrar la base descartable; reporta error si no puede limpiarla. Nunca borra `sedeagro_test`.

El resto del workflow sigue ejecutando pruebas contra la base original como antes y la verificación de hashes del frontend realmente servido por Nginx de 0T.3. La ejecución está sujeta al CI del HEAD exacto, con los dos jobs `tenant-rls` y `browser-offline`.

## Qué demuestra y qué NO

**Demuestra únicamente cuando el CI resulte SUCCESS:** que este esquema y estos catálogos de una base de prueba pueden respaldarse, restaurarse, reprovisionarse y permitir la misma suite de aislamiento/seguridad. La verificación de migraciones cuenta entradas en `sequelize_migrations`; no sustituye una revisión de compatibilidad hacia atrás o una prueba de escritura continua.

**No demuestra:** integridad del backup de staging con volumen real, retención, cifrado en almacenamiento externo, rendimiento sobre datos y fotografías voluminosas, tiempos de restauración, restauración de Redis, compatibilidad de versiones ejecutadas, recolección de operaciones posteriores al dump ni rollback real. Todos estos apartados siguen **NOT_RUN**.

## Para aceptación real en staging (no ejecutado por este bloque)

| Gate | Criterio requerido | Estado |
| --- | --- | --- |
| STG-DB-01 | Dump consistente de staging sin credenciales en logs, archivo cifrado y almacenamiento externo | NOT_RUN |
| STG-DB-02 | Restauración en instancia totalmente aislada, con imagen PostGIS/versiones compatibles y conteos/huella | NOT_RUN |
| STG-DB-03 | API contra restaurada con rol limitado, RLS y dos empresas, evidencias y reportes | NOT_RUN |
| STG-DB-04 | Ensayo de rollback de frontend/backend sin pérdida de cambios posteriores al backup | NOT_RUN |
| STG-APP-01 | SHA/digest de backend verdaderamente ejecutado y migraciones compatibles | NOT_RUN |
| STG-WEB-01 | Bytes servidos HTTPS validados contra artefacto firmado por CI | NOT_RUN |
| MOB | Safari/iPhone, Chrome/Android y red rural, permisos, fotos, IndexedDB, reconciliación | NOT_RUN |
| GO-NOGO | Aprobación firmada del piloto y contingencias documentadas | NOT_RUN |

Continuar con el runbook `docs/ops/0t3-staging-release-gates.md` antes de cualquier instalación manual en staging. **No ejecutar `scripts/deploy-prod.sh` como atajo para probar staging.**
