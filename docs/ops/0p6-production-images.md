# 0P.6 — Construcción de imágenes de producción a partir de lockfiles

## Riesgo corregido

Las imágenes `backend` y `frontend` ejecutaban `npm install` usando rangos semver; por eso podían instalar dependencias distintas a las probadas por GitHub Actions. Además, el frontend carecía de `.dockerignore`: la etapa de Vite copiaba indiscriminadamente archivos locales del contexto, incluyendo posibles `.env`. El CI de aplicación corría con Node 22 y las imágenes con Node 20.

## Nuevo contrato de build

- Ambos Dockerfiles utilizan `node:22-alpine` y copian **`package.json` más `package-lock.json`** antes de `npm ci`.
- El backend productivo usa `npm ci --omit=dev` y copia expresamente `src`, `db` y `scripts`. No incluye el directorio `test` ni un `.env`.
- El frontend usa `npm ci` en la etapa de build, ejecuta `npm run build` con `VITE_API_URL=/api` (mismo origen), y la etapa final Nginx copia exclusivamente `dist`.
- Los `.dockerignore` de ambas capas excluyen `.env`, `.env.*`, material típico de claves y certificados, `node_modules`, logs, `dist`/temporales cuando corresponde. **No usar variables secretas como argumentos de Vite**: toda variable `VITE_*` se incorpora al JS público.
- Los tests unitarios de release verifican explícitamente versiones de Node, concordancia entre `package.json` y root package de cada lockfile y restricciones de contextos.
- Se agrega el job independiente `production-images` al CI para **construir ambas imágenes finales reales en un runner descartable** sobre el SHA exacto y verificar Node, dependencias, fuentes y assets compilados, además de ejecutar `nginx -t` sobre el contenedor resultante.

## Límites de reproducibilidad

`npm ci` fija dependencias JavaScript por lockfile, pero **no convierte Docker en un artefacto bit-a-bit reproducible**: `node:22-alpine`, `nginx:1.27-alpine`, `postgis/postgis:16-3.4` y `redis:7-alpine` siguen siendo tags mutables. Un siguiente bloque debe fijar digest OCI, añadir manifiestos de las imágenes realmente desplegadas y comparar los hashes en staging. No se publica una imagen a registro alguno ni se instala en VPS con este bloque.

El job valida una construcción real en CI, no una ejecución completa de la API contra la base de staging: los otros jobs comprueban PostgreSQL/PostGIS, sesión, RLS, backup/restore y Chromium. El operador debe conservar la relación SHA → imagen → migraciones y completar la aceptación manual de staging antes de cualquier autorización productiva.

## Go/no-go

Un CI verde de las imágenes es **necesario pero insuficiente**: aún faltan la restauración de un backup de staging, verificación del release ejecutado desde fuera, QA en Android/iOS reales, red rural, rendimiento de la review queue (#105), intermitencia del foco Chromium (#86), plan de rollback y aprobación final. Este bloque no ejecuta ningún despliegue.
