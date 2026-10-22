# 0P.30 — Retirar npm global del backend runtime, sin perder migraciones

## Hallazgo exacto (NO certificación de release)

SBOM/Trivy completos de la imagen backend de `main` `2752a1214faba6a298f4b6b1fc9f861d92b8a79c` (artefacto `sedeagro-security-2752...`, run 39670458882) detectan 22 hallazgos: 11 HIGH, 10 MEDIUM, 1 LOW. Los **11 HIGH** señalan archivos en `usr/local/lib/node_modules/npm/node_modules/`, instalados globalmente por `node:22-alpine`, no por dependencias HTTP de SedeAgro: `brace-expansion` (5 HIGH), `pacote` (2), `ip-address`, `picomatch`, `sigstore`, `http-cache-semantics`. Última: CVE-2026-93748, sin FixedVersion informada en Trivy al 2026-10-21. Estas herramientas de instalación no hacen falta para servir peticiones HTTP, pero npm estaba en la imagen ejecutable.

La instalación de dependencias **con npm y lockfile** se mantiene estrictamente dentro de Docker build `RUN npm ci --omit=dev`; después se retiran `/usr/local/lib/node_modules/npm` y sus puntos de entrada `/usr/local/bin/npm` y `/usr/local/bin/npx`. El backend final pasa a `CMD ["node","src/server.js"]` (mismo destino que `package.json scripts.start`). No se alteran dependencias, repositorio de paquetes, API, DB, RLS, frontend funcional ni configuración de production/staging.

## Conservación del camino de migración

`scripts/deploy-prod.sh` antes usaba `npm run db:prepare` **dentro de la imagen runtime**. Los scripts originales definen `db:prepare = npm run migrate && npm run seed`, con `migrate = node src/infra/db/migrate.js up` y `seed = node src/infra/db/seed.js up`. El comando operacional equivalente es `node src/infra/db/migrate.js up && node src/infra/db/seed.js up`, ejecutado con la misma conexión `DATABASE_URL` de owner. Los fail-closed de backup/FIRST_DEPLOY, roles, rollback y checks anteriores permanecen intactos.

**No ejecutar ese script ni sus migraciones** sin la aprobación de operador/data owner y los procedimientos completos de #130. Un shell manual `docker compose run backend npm ...` dejará de funcionar con esta imagen, por diseño: usar exclusivamente `node` y los comandos versionados tras revisar el procedimiento y el entorno.

## Criterio de verificación

1. Unit tests estáticos prueban el entrypoint, rutas y equivalencia de migración, y preservan `npm ci --omit=dev` para construir con el lockfile.
2. CI `production-images` construye el contenedor REAL y ejecuta `test ! -e /usr/local/lib/node_modules/npm`, `! command -v npm` y `! command -v npx`; también verifica Node22, Express y archivos esperados.
3. Syft + Trivy generan inventario REAL de la nueva imagen del SHA del PR. Los 11 HIGH de npm global **deben desaparecer sin crear fallas de build**; verificar el JSON entero y que no queden vulnerabilidades HIGH/CRITICAL ajenas.
4. Merge normal solo tras checks exact-head; posmerge MAIN requiere 6/6 y firma de evidencia. **No reutilizar cifras/artefactos anteriores, no liberar producción por este PR**.

## Riesgo residual

La imagen frontend `nginx:1.27-alpine` contiene 2 CRITICAL + 57 HIGH y requiere actualización de imagen/digest verificado en otro PR coordinado. Se mantienen además pruebas de staging, TLS, datos privados, backup offsite, restore, rollback con escrituras y Android/iOS. El runtime npm-free puede requerir actualizar manuales externos que asumían presencia de `npm` en un contenedor productivo: sin prueba externa, no considerar cerrada esa validación. **#130 NO-GO.**
