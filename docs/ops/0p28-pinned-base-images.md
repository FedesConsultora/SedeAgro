# 0P.28 — Bloqueo de imágenes base por digests inmutables

## Problema detectado

0P.24–0P.27 prueban bytes de la imagen final frontend, guardan un TAR con las dos imágenes productivas, las importan en un runner independiente y verifican attestations firmadas GitHub/Sigstore para TAR y recibo. **Sin embargo**, cuatro referencias de base continuaban usando tags mutables (`node:22-alpine`, `nginx:1.27-alpine`, `postgis/postgis:16-3.4` y `redis:7-alpine`). Dos builds con el mismo SHA de Git podrían acabar usando bases distintas si alguien moviera el tag en Docker Hub, aun cuando los dos TAR individuales fueran íntegros y firmados.

0P.28 pinnea los cuatro orígenes por `tag@sha256:<digest>` real. No cambia el código de negocio, los esquemas SQL, los datos ni el contrato de API. El tag permanece como referencia legible de la familia/version; **el digest es la autoridad para los bytes que se descargan**.

## Procedencia de los cuatro digests

El 21 de octubre de 2026, el GitHub Actions de prueba para [PR #161](https://github.com/FedesConsultora/SedeAgro/pull/161) consultó directamente Docker Hub usando `docker buildx imagetools inspect` sobre los cuatro tags. Evidencia de lectura de registry: [run de resolución 39662011784](https://github.com/FedesConsultora/SedeAgro/actions/runs/39662011784), job `production-images`, delimitadores `BASE_IMAGE_PROBE_BEGIN` / `BASE_IMAGE_PROBE_END`. Los resultados se congelaron en `scripts/base-image-lock.json` y se copian literalmente en todos los consumidores.

| Base | Digest SHA256 fijado | Formato de manifiesto |
| --- | --- | --- |
| Node.js 22 Alpine | `ce8d97f7cfc7c5386421eb932df20a29df99b1a7f469f6157d5c9956702ffadc` | OCI index multiplataforma |
| Nginx 1.27 Alpine | `65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10` | OCI index multiplataforma |
| PostGIS 16-3.4 | `44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5` | Docker manifest de plataforma única |
| Redis 7 Alpine | `858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` | OCI index multiplataforma |

El digest es de **índice multiplataforma** donde lo indica la tabla, no necesariamente el de la imagen hijo `linux/amd64`. PostGIS entrega un **manifest Docker simple**. Los digests no se inventaron, ni se trataron como comprobante de una firma del publisher. Las bases se siguen obteniendo de Docker Hub por HTTPS; no se publica ni descarga nada desde el VPS.

## Archivos cubiertos y uso

- `backend/Dockerfile`: único `FROM node:22-alpine@sha256:...` de la etapa `base` usada por `dev` y `prod`.
- `frontend/Dockerfile`: ambos `FROM node:22-alpine@sha256:...` (`dev` y `build`) y la imagen final `nginx:1.27-alpine@sha256:...`.
- `docker-compose.yml`: `db` PostGIS y `redis` fijados para producción; se preservan nombres/volúmenes internos, healthchecks, redes y dependencias.
- `docker-compose.dev.yml`: mismas bases para desarrollo; PostGIS conserva `platform: linux/amd64` para compatibilidad, y Redis puede resolver plataforma host desde su índice.
- `docker-compose.staging.yml`: dos servicios externos a la aplicación fijados; se preserva el proyecto/red/volúmenes aislados, el puerto frontend loopback y la política de no desplegar automáticamente.
- `.github/workflows/postgres-isolation.yml`: PostGIS descartable de GitHub Actions también fijado con el mismo digest; se comprueba que el contenedor arrancado ejecuta una imagen `linux/amd64`.
- `scripts/ci-disposable-restore.sh`, `scripts/ci-independent-recovery.sh` y `scripts/ci-rollback-rehearsal.sh`: todos los controles de backup/restauración y rollback sintéticos de PostGIS exigen **el mismo digest fijado** antes de cualquier operación de datos; el segundo contenedor de recuperación sin red también se crea con `tag@sha256`, nunca con un tag mutable.

El worker optativo de reportes continúa reutilizando el mismo Dockerfile backend bloqueado; no se añade un servicio base nuevo.

## Verificación automática contra regresiones

La política central `scripts/base-image-lock.json` tiene cuatro tags permitidos, sus digests `sha256`, media types y plataforma objetivo `linux/amd64`. El verificador `scripts/verify-base-image-pins.mjs` incluye dos modos:

1. `--offline`: recorre **los nueve archivos de consumo y recuperación** y exige el número exacto de referencias de cada familia y que todas sean literalmente `tag@digest` igual a la política. Un nuevo `FROM`, un `image: ...:latest`, una sustitución de digest o una omisión de PostGIS en CI quedan bloqueados. Corre con Node 22 sin Docker, credenciales, red ni ejecución de contenedores.
2. `--online`: además del control anterior, exclusivo de GitHub Actions, resuelve **cada `tag@digest` ya fijado**, no el tag mutable, con `docker buildx imagetools inspect`. Compara digest y media type exactos. Exige que los tres índices multiplataforma incluyan `linux/amd64`. PostGIS, con manifest único que no declara plataforma en el índice, se comprueba por separado mediante el contenedor PostGIS real y saludable usado en `tenant-rls` (Docker inspecciona el OS/arquitectura de la imagen por ID).

Pruebas adversarias `scripts/test/base-image-pins.test.mjs` ejercitan regresiones en todos los consumidores, digest alterado, fuente desconocida, nuevas etapas, recuentos incorrectos, tipo de manifest diferente, salida del registry falsificada, ausencia de plataforma amd64 y negativa fuera de CI. Los guardas previos de producción y staging también fueron adaptados para exigir las nuevas referencias. Ningún resultado CLI debe mostrar secretos del Compose.

Los checks premerge exact-head y posmerge main conservan los jobs existentes, incluido el firmado Sigstore del 0P.27 y la importación independiente de TAR. No se aceptan resultados de SHAs anteriores.

## Cómo actualizar imágenes base correctamente

Los digests son intencionalmente **inmutables** y no se actualizan automáticamente, incluso cuando el upstream publica un parche importante. La actualización deberá seguir un PR explícito:

1. Revisar la seguridad, versiones y compatibilidad de Node/Nginx/PostGIS/Redis, y confirmar que el operador conoce cualquier cambio de librerías/códigos, arquitectura y persistencia.
2. Resolver los manifests del publisher mediante un runner aprobado `docker buildx imagetools inspect TAG`; registrar tag original, digest de índice o manifest, plataforma requerida, timestamp y evidencia del registry en el PR. **No copiar un digest de una conversación ni de una caché local sin verificación.**
3. Modificar el lock de forma atómica junto con todos sus consumidores `FROM`/Compose/workflow. Ninguna sustitución implícita de un tag diferente queda autorizada.
4. Ejecutar controles offline/online y todo GitHub Actions, incluyendo PostgreSQL/PostGIS real, aislamiento RLS, Chromium, paridad frontend, TAR verificado, recuperabilidad y attestations del nuevo SHA.
5. Exigir revisión técnica/seguridad. Si cambia la versión mayor de PostGIS o el formato de datos, requerir revisión del plan de migraciones y backup; no asumir compatibilidad solo por `docker pull`.

**Rollback de código:** si un pin causa fallos en CI, mantener el PR sin fusionar y recuperar la versión anterior del lock/refs en la rama. **Rollback de infraestructura:** este bloque no despliega ni cambia imágenes en servidores; nunca reemplazar las bases reales ni usar `docker compose up` sin el procedimiento externo y aprobación separada.

## Límites de certificación

Los digests garantizan una identidad de **contenido de imágenes fuente** dentro del repositorio y permiten detectar drift de tags. **No prueban** automáticamente que la imagen del publisher está firmada o exenta de vulnerabilidades, que los paquetes `npm ci` son reproducibles de forma integral en el tiempo, que una rebuild futura produce el mismo TAR, ni que el registry soporte disponibilidad indefinida. Los OCI IDs/config IDs de imágenes construidas siguen siendo distintos de los digests de manifest/índice del registry.

**#130: staging y producción permanecen NO-GO** hasta las pruebas reales de TLS, RLS con datos privados, backup off-VPS, aceptación física Android/iOS, operación y firmas. No se ha realizado despliegue ni acceso a VPS, configuración DNS, certificados o bases privadas.
