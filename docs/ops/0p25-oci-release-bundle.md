# 0P.25 — Paquete OCI/Docker transportable y verificación fuera de línea

## Brecha de procedencia tras 0P.24

0P.24 demostró que la imagen final Nginx **construida por CI** contiene exactamente los bytes de la SPA de la misma revisión, y corrigió archivos Nginx heredados y entradas Vite inconsistentes. Sin embargo, el runner descartaba las dos imágenes Docker al finalizar la prueba. Ni el tag `sedeagro-*-rc:<SHA>` ni el ID de imagen local son un **artefacto transportable** o un digest remoto de registry. Sin bytes conservados, un operador podría descargar o reconstruir algo diferente sin detectarlo.

0P.25 crea una vía de transporte verificable sin publicar nada en registry, instalar nada en VPS ni leer datos privados.

## Artefacto producido

Tras construir ambas imágenes productivas reales, probar Nginx/Node y cerrar la paridad 0P.24, el job `production-images` ejecuta **`docker save --output` de ambos tags SHA exactos en un mismo archivo**. No arranca nuevos servicios ni crea redes. El par de salida:

- `sedeagro-images-<SHA>.tar`: archivo estándar `docker save` que contiene **backend y frontend** (misma revisión Git de 40 caracteres) y sus capas.
- `sedeagro-images-<SHA>.json`: recibo de contenido SHA256 del TAR completo, tamaño, formato, SHA Git, tag y ID de configuración `sha256:…` de cada imagen, plataforma Linux/amd64, y digests `rootfs.diff_ids` de las capas en orden.

Ambos archivos se guardan temporalmente dentro de `$RUNNER_TEMP/sedeagro-oci` con permisos privados. CI comprueba que el directorio, nombre y SHA correspondan a la ejecución actual y genera el recibo solo con `CI=true`, `GITHUB_ACTIONS=true`, `IMAGE_SHA` y Git HEAD exacto. El recibo se crea una sola vez, sin sobrescribir contenido previo.

La política de GitHub Actions **sube el par únicamente tras un `push` integrado en `main`** bajo el artefacto `sedeagro-oci-<SHA>` con retención **7 días** y compresión desactivada para no añadir trabajo innecesario a un TAR que puede ser grande. En PRs se ejecuta el mismo save/verificador completo, pero el TAR no se publica como artefacto de release. Ninguna imagen se publica a Docker Hub ni a GitHub Container Registry.

## Verificación técnica real (sin Docker ni red)

`scripts/oci-release-bundle.mjs` inspecciona **bytes del TAR** mediante lecturas acotadas; nunca llama a `tar -xf` ni extrae rutas arbitrarias. Rechaza TAR sin encabezados válidos, truncado, sin terminación doble en cero, con bytes inesperados al final, archivos especiales o links, rutas absolutas/`..`/duplicadas y miembros no referenciados; fija límite de archivo **1,5 GiB**, máximo 2048 miembros, metadatos JSON de máximo 2 MiB por archivo y lectura de capas en bloques de 1 MiB.

Para el `manifest.json` de `docker save` obliga **exactamente dos** imágenes con los tags SHA esperados. **Los formatos Docker modernos también incluyen `oci-layout`, `index.json` y blobs de manifiesto OCI que no están directamente referenciados en el `manifest.json` heredado**. Esos metadatos adicionales se verifican como un grafo criptográfico: el índice debe describir exactamente dos imágenes, cada descriptor exige SHA256 y tamaño coincidentes con el blob real, y los manifiestos OCI deben apuntar a las mismas configuraciones backend/frontend y a sus capas. Los blobs ajenos o desreferenciados siguen siendo bloqueantes; no se admiten como excepciones genéricas. Lee los bytes reales de cada `Config`, calcula su SHA256 y exige que coincida con el identificador de imagen. Comprueba que ambos config files declaren `org.opencontainers.image.revision=<SHA>`, tengan plataforma `linux/amd64`, y que backend incluya el runtime `SEDEAGRO_BUILD_SHA` exacto. Después calcula SHA256 de los **datos completos de cada capa TAR** y exige igualdad con el `rootfs.diff_ids` correspondiente, conservando el orden de layers. Las pruebas sobre el runner exigen además que **ambas imágenes Docker realmente construidas** tengan `docker image inspect` ID, tags, capas y labels idénticos a los exportados.

Finalmente genera el SHA256 del TAR completo y lo compara contra el recibo. El modo `verify` usa únicamente Node y lectura de archivos, sin Docker, `git`, registry, HTTP ni comandos de importación: sirve como verificador para un artefacto descargado y trasladado fuera del runner.

### Comando de revisión sin efectos secundarios

Extraer **solo el par de archivos** de un artefacto `sedeagro-oci-<SHA>` cuyo run y HEAD exacto fueron comprobados por otro canal. Desde un checkout revisado que contenga el verificador:

```bash
node scripts/oci-release-bundle.mjs verify \
  --sha "SHA_GIT_COMPLETO_VERIFICADO_EXTERNAMENTE" \
  --bundle "/ruta-privada/sedeagro-images-SHA_GIT_COMPLETO_VERIFICADO_EXTERNAMENTE.tar" \
  --receipt "/ruta-privada/sedeagro-images-SHA_GIT_COMPLETO_VERIFICADO_EXTERNAMENTE.json"
```

Esto comprueba bytes transportados y procedencia declarada del contenido de las imágenes **respecto del SHA autorizado por el operador**. No importa contenedores, no inicia ni detiene servicios y no accede a credenciales.

## Qué no certifica

1. **No es una firma criptográfica ni attestación externa**: quien pueda sustituir **ambos** archivos también puede generar un recibo nuevo. La identidad del workflow/run GitHub, su SHA y el origen de descarga tienen que corroborarse por un canal independiente y de confianza. CI comprometido también podría elaborar un par falso.
2. El ID `sha256:` de una configuración Docker y sus `diff_ids` NO son un digest de imagen publicado `repository@sha256:…`, ni un comprobante firmado de un registry OCI. No declarar `registry_digest_certified` o `signed_provenance_certified`.
3. No garantiza builds bit a bit reproducibles días después: tags de bases Node/PostGIS/Nginx y Redis siguen siendo mutables hasta que se pinneen a digests auditados. El TAR conserva **estos** bytes exactos, no los bytes de builds futuros.
4. El archivo TAR puede contener código y paquetes privados. Solo descargarlo a almacenamiento aprobado, no adjuntarlo a incidencias públicas, no subirlo a buckets abiertos, no guardar secretos en logs. El backend ya tiene gates contra `.env`, pero este script no constituye un escáner universal de secretos.
5. No se instala ni se hace `docker load` automáticamente. Un operador autorizado puede después efectuar la importación en un entorno de recuperación segregado mediante un procedimiento externo al bloque; eso requiere controles de seguridad, recursos, aprobación y cotejo del ID cargado.
6. El archivo solo vive **7 días** en GitHub Actions; no es backup offsite de datos de negocio ni un registry permanente. No mide RTO/RPO real.
7. El **GO de piloto #130 sigue NO-GO**: no HTTPS/TLS real de staging, roles DB/RLS sobre datos privados, recuperación off-VPS, digest de registry, coordinación de cambio, monitoreo, QA Android/iOS físicos ni aprobación de responsables.

## Criterio de integración

- PR exact HEAD: `tenant-rls` ejecuta tests de TAR sintéticos adversarios, y `production-images` construye ambas imágenes reales, las exporta juntas y verifica SHA256 completos de TAR, config y capas; además `browser-offline` y `dependency-security` pasan.
- Solo después de los 4/4 SUCCESS premerge: merge normal preservando commits atómicos.
- Un nuevo `push` **independiente** sobre el SHA resultante de `main` debe cerrar 4/4 SUCCESS y subir el artefacto `sedeagro-oci-<nuevo SHA>` con ambos archivos. Comparar run/head exactos. La existencia de un artefacto no certifica instalación ni firmas.
