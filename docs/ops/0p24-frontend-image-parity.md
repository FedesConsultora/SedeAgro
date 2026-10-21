# 0P.24 — Paridad íntegra entre frontend Docker y artefacto CI

## Problema real

En los bloques 0P.4, 0T.3 y 0P.6 se agregó un manifiesto `staging-release-manifest.json` con hash SHA256 y tamaño por archivo, un verificador byte a byte de la SPA servida sobre HTTPS y una imagen Nginx productiva construida desde `frontend/package-lock.json`. Sin embargo, CI solo exigía que **el label OCI del contenedor** coincidiera con el SHA del HEAD, que `index.html` y `sw.js` existieran, y que `nginx -t` aprobara. No comprobaba que **cada archivo realmente empaquetado en la imagen Docker fuera idéntico al artefacto CI de referencia**, ni que su `default.conf` fuera exactamente el archivo revisado.

Una imagen puede llevar un label correcto y contener JavaScript distinto, archivos no incluidos en el manifiesto, un service worker alterado o una configuración Nginx inesperada. Esta brecha no queda cerrada mediante `docker image inspect` únicamente.

## Cambio implementado

La ejecución real del job `production-images` se amplía **después** de construir y revisar las imágenes finales:

1. Prepara Node 22 en el runner descartable y ejecuta `npm --prefix frontend ci` usando exclusivamente el lockfile de frontend. Compila `VITE_API_URL=/api npm --prefix frontend run build` como **referencia separada del Docker build**. Es indispensable usar **el mismo origen API** en ambas construcciones; de otra manera Vite puede emitir nombres con hash diferentes sin que exista manipulación del código. Además el job `browser-offline` fija `VITE_API_URL: /api` al producir el archivo descargable `sedeagro-staging-<SHA>` sobre `main`.
2. Genera `staging-release-manifest.json` con el Git HEAD exacto usando `scripts/staging-release-manifest.mjs create`, lo valida de nuevo mediante `verify` y exige índice, service worker y assets versionados.
3. Ejecuta `scripts/verify-frontend-image-parity.mjs --sha "$IMAGE_SHA"`, que admite únicamente `CI=true`, `GITHUB_ACTIONS=true` y un SHA40 idéntico al checkout y al que se utilizó para construir la imagen.
4. Usa `docker image inspect` **únicamente** sobre el tag exacto `sedeagro-frontend-rc:<SHA>`, exige el label OCI de revisión exacto y registra su ID local SHA256 de imagen.
5. Crea un contenedor **detenido** mediante `docker create --network none --entrypoint /bin/true`. **Nunca ejecuta `docker start`, `docker run`, `docker exec`, `docker push`, `docker pull` ni publica puertos**. `docker cp` copia el árbol completo `/usr/share/nginx/html` y `/etc/nginx/conf.d/default.conf` a un directorio efímero privado del runner.
6. Recorre todos los archivos de la imagen sin seguir symlinks ni hardlinks: compara la **lista EXACTA** de rutas permitidas, tamaño y SHA256 de cada archivo frente al manifiesto CI. No admite archivos adicionales, ocultos o vacíos, archivos faltantes, cambios de igual tamaño, directorios peligrosos ni recursos fuera de los límites 500 archivos / 32 MiB por archivo / 150 MiB total.
7. Compara el hash del archivo Nginx empacado frente a `frontend/nginx.conf` del SHA de checkout. Destruye el contenedor efímero y los archivos copiados tanto si pasa como si falla. Si la limpieza falla, el resultado también es bloqueante.

Los errores no imprimen contenido de archivos, configuración Docker ni variables de entorno. El resumen solo informa `release_sha`, ID de imagen local, conteos, bytes verificados y SHA256 del Nginx. El resultado exitoso tiene estado **`CI_IMAGE_PARITY_REVIEW_REQUIRED`**, NO una aprobación productiva.

## Defecto productivo hallado por el primer gate real

La primera ejecución de CI reveló **un problema verificable de empaquetado** que no habían detectado las pruebas de existencia de `index.html`/`sw.js`: la imagen base `nginx:1.27-alpine` instala archivos web propios (por ejemplo `50x.html`). El antiguo `COPY --from=build /app/dist /usr/share/nginx/html` sobrescribía el index pero **no eliminaba** esos archivos preexistentes. El validador nuevo los rechazó, correctamente, por no existir en el manifiesto de Vite.

La corrección acotada en `frontend/Dockerfile` elimina y recrea **solo el document root de la imagen en la fase final de build**, antes de copiar los assets Vite. No elimina nada del host ni del VPS. Una regresión comprueba el orden de esas instrucciones; GitHub Actions también exige que el contenedor final no tenga `/usr/share/nginx/html/50x.html` y que la lista completa de archivos coincida con el manifiesto generado de modo independiente. **No se relajó el verificador** para ignorar archivos extra.

## Pruebas adversarias y aceptación

- Byte faltante o alterado en JS, CSS o `sw.js`, incluso si el tamaño total no cambia.
- Archivos extra ocultos como `.env`, faltantes, symlinks, hardlinks y rutas maliciosas.
- Reemplazo de `nginx.conf` con exactamente el mismo tamaño.
- Manifiesto firmado lógicamente con un SHA distinto, tamaño imposible, digest alterado o ruta `../`.
- Imagen con tag distinto, label OCI que no coincide o ID local inválido.
- Error al borrar contenedor inspeccionado y limpieza de temporales ante fallos.
- Invocación CLI fuera de GitHub CI (se niega antes de tocar Docker).
- Configuración CI con build independiente más validación **real** de archivos de imagen.

El mismo test unitario corre en `tenant-rls` y en `production-images`, pero **solo el segundo construye realmente el Docker image y compara sus archivos empaquetados con un build independiente**. Se deben requerir los 4/4 checks GitHub Actions sobre HEAD exacto de PR antes de un merge normal y los 4/4 de una corrida `push` independiente sobre el `main` resultante. Ningún resultado de otro SHA sirve.

## Límites expresos — no equivale a release GO

- El identificador `sha256:…` informado es un **ID LOCAL de imagen Docker**, no un digest `repo@sha256:…` recuperado o firmado desde un registry. La imagen no se publica ni se firma en este bloque.
- El manifiesto de referencia es generado por CI sobre el checkout exacto, no una firma independiente de una tercera parte. No garantiza por sí solo autenticidad de la procedencia del source ni protección frente a un runner comprometido.
- La comparación ocurre sobre dos builds realizados en el mismo runner/commit, uno fuera y otro dentro de Docker; no se ha comprobado reproducción entre diferentes sistemas, arquitecturas o fechas.
- La imagen backend conserva sus validaciones existentes de Node22/dependencias/label OCI, pero este bloque no calcula ni certifica un digest registry inmutable para backend/DB.
- Sigue pendiente instalar el SHA en un **staging externo real autorizado**, confirmar HTTPS/HSTS, comparar SHA frontend realmente servido mediante `verify-deployed-staging.mjs` con el artefacto de CI, comprobar backend/DB/RLS/recovery real, observar report workers y realizar aceptación en dispositivos Android/iOS físicos.
- El gate solo opera sobre contenedores efímeros en CI. No contacta ni cambia VPS, Docker de producción, staging, certificados, DNS, secretos reales ni bases de datos.

**Matriz de piloto #130: sigue NO-GO** mientras falten las verificaciones operativas y firmantes independientes. La aceptación de código/CI no debe marcar como completadas las casillas de staging o producción.
