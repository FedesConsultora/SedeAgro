# 0R.39 — Identidad efectiva de imágenes base en staging OCI firmado

**11/11/2026 · Release #130: NO-GO.**

## Brecha comprobada

La revisión read-only de staging aseguraba que `Config.Image` para `db` y `redis` coincidiera con las referencias fijadas del lockfile (`postgis/postgis:16-3.4@sha256:…` y `redis:7-alpine@sha256:…`). Sin embargo, esa propiedad indica la **referencia con la que el contenedor fue creado**, no coteja de manera independiente el `Image` (config ID SHA256 de la imagen realmente ejecutada) con el registro de imágenes local del daemon.

A diferencia de backend/frontend, donde la revisión OCI ya exigía un `Config.Image` inmutable idéntico al `Image` real, las imágenes base podían conservar una referencia aparentemente correcta pero tener un ID diferente sin bloquear la revisión firmada. Un contenedor `healthy`, con un bridge privado y volúmenes correctos no demuestra la identidad de su binario base.

## Nuevo contrato de solo lectura

Solo en **modo OCI firmado/inmutable**, y después de comprobar el censo exacto de cuatro contenedores, el inspector ejecuta:

```text
docker image inspect --format '{{json .}}' <referencia-PostGIS-fijada>
docker image inspect --format '{{json .}}' <referencia-Redis-fijada>
```

Ambas referencias son constantes del lockfile aprobado; nunca provienen de argumentos del operador ni de un entorno heredado.

Para cada imagen se exige:

- `Id` con formato `sha256:<64 hex>`, idéntico a `container.Image` del servicio correspondiente.
- `container.Config.Image` exactamente igual a su referencia fijada, con tag y digest SHA256.
- `RepoDigests` contiene la referencia canónica `repositorio@sha256:…` que corresponde al lockfile (incluyendo las formas cualificadas de Docker Hub).
- Dos IDs base distintos, respuesta JSON válida y acotada.

Solo entonces se agrega al reporte `project_base_image_inventory_verified:true` y `project_base_image_ids` para los servicios `db` y `redis`. `review-signed-staging-runtime.mjs` exige ambos en sus **dos rondas**, sin aceptar IDs de bases iguales entre sí o a las dos imágenes de aplicación firmadas, y bloquea la sustitución de una imagen base entre lecturas.

La inspección legacy permanece en modo revisión sin certificación de firma: no realiza el inventario adicional de imágenes base ni emite el indicador firmado.

## Regresiones

```bash
node --check scripts/verify-staging-runtime.mjs
node --test scripts/test/staging-runtime.test.mjs scripts/test/review-signed-staging-runtime.test.mjs
```

Hay negativos para ID real de base distinto, digest de repositorio equivocado, alias no autorizado, metadata faltante/malformada, servicios con la misma imagen, referencia modificada, falta de bandera OCI y cambio de PostGIS/Redis entre rondas. El mock de Docker exige que **solo** se inspeccionen las dos imágenes con referencias fijadas.

## Límites de seguridad

Esto verifica coherencia de la información del daemon Docker y lockfile, **no firma criptográfica de las imágenes upstream** ni integridad física de un host comprometido. Los checks de firma OCI Sigstore de backend/frontend permanecen separados; tampoco demuestra conectividad RLS real, firewall, TLS externo, aceptación móvil ni recuperación de datos fuera del VPS.

El código es read-only y no invoca `docker pull`, `image load`, `build`, `compose up`, `exec` ni toca bases de datos, credenciales o servicios reales.

**NO-GO:** siguen pendientes staging HTTPS real autorizado, restore externo medido, rollback/RTO/RPO, Android/iOS físicos, matriz de seis actores y aprobaciones humanas de Seguridad/Operaciones/Datos/Producto.
