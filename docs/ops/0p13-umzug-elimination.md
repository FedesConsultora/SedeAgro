# 0P.13 — Eliminación de dependencia de CLI de migraciones vulnerable

## Riesgo auditado
El lockfile productivo tenía `umzug@3.8.3` → `@rushstack/ts-command-line@4.19.1` → `argparse@1.0.10` → `sprintf-js@1.0.3`, un aviso directo [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) de denegación de servicio sin parche upstream publicado a 20/10/2026. El producto **no usa el CLI de Umzug**: solo invoca las operaciones programáticas `up/down/status` de las migraciones del repositorio y usa una tabla `sequelize_migrations` / `sequelize_seeders` como ledger.

Se eliminó `umzug` y los paquetes vulnerables transitivos del `backend/package-lock.json` y del `package-lock.json` de workspaces, **sin ignorar el escáner ni aprobar la vulnerabilidad**. `tinyglobby` se conserva donde lo usa el frontend; el backend deja de necesitarlo.

## Comportamiento compatible
- `backend/src/infra/db/trackedMigrations.js` descubre únicamente módulos `.js` regulares del directorio versionado, en orden estable, sin seguir symlinks. Invoca los `export up/down({name,path,context:sequelize.getQueryInterface()})` existentes sin editar las migraciones históricas.
- Reutiliza los nombres de tabla exactos `sequelize_migrations` y `sequelize_seeders`, con la columna SequelizeStorage `name STRING PRIMARY KEY`. El almacenamiento se sincroniza como lo hacía Umzug; los registros ya aplicados quedan reconocidos. `up` instala solo pendientes; `down` revierte **una** migración, la última ejecutada; `status` lista ejecutadas/pendientes. Un archivo histórico desaparecido bloquea upgrades del esquema en vez de aplicar una migración inconsistente.
- El seeder en producción solo permite `*_seed_global_*.js`; `SEED_MODE=demo` fuera de producción es opt-in mediante `seedPolicy.js`. Los registros de demo ya existentes se preservan si se corre en modo global. La función de módulo se ejecuta antes de marcar el ledger como completado, igual que Umzug.
- Importante: como el runner anterior, **no** se introduce una migración distribuida entre varias transacciones. Si un script ejecutó DDL y falló antes de registrar la versión, el operador debe reparar/recuperar el entorno por el runbook; nunca se declara éxito por inferencia. El despliegue permanece bloqueado antes de migraciones sin respaldo verificado.

## Pruebas y aceptación
Las pruebas de `backend/test/trackedMigrations.test.js` ejercitan descubrimiento, up repetido, down de una sola versión, status, compatibilidad de nombres de ledger, rechazo de archivos aplicados ausentes, errores intermedios sin marker y filtro de seeds global/demo. La CI PostgreSQL/PostGIS arranca esquema nuevo, ejecuta `db:prepare` REAL, comprueba RLS/FORCE, ejecuta varias suites API y además restaura un dump real descartable y repite las pruebas. `production-images` construye backend con `npm ci --omit=dev`. `dependency-security` corre `npm audit --omit=dev --json` independiente con baseline ajustado.

**Esperado:** bajar de 6 a 2 advisories moderados (solo `sequelize@6.37.8` y `uuid@8.3.2`), NO bajar aún a cero. La política continúa `unaccepted-for-release`, el gate productivo de 0P.12 sigue rechazando el despliegue. Si `npm audit` reporta más o menos, no confiar en el conteo escrito aquí: obedecer la auditoría real, investigar y actualizar la política solo con evidencia.

## Riesgos abiertos
- Sequelize v6 requiere en su rango `uuid ^8.3.2`; la vulnerabilidad [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) está corregida en uuid 11.1.1, pero se necesita prueba de compatibilidad CommonJS/API Sequelize antes de intentar override. No forzar arbitrariamente a v12+ ESM.
- La eliminación de Umzug simplifica superficie, pero modifica el motor de migraciones: comparar siempre el ledger histórico y una restauración del DB en staging privado antes de producción; nunca confiar solo en CI nueva/descartable.
- Staging real, restore privado/rollback, permisos TLS/cookies, móviles reales, field-offline, observabilidad y la firma de GO siguen obligatorios.
