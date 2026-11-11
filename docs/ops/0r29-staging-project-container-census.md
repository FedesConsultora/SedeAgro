# 0R.29 — Inventario completo de contenedores de staging OCI firmado

**10/11/2026 · Coordinación #18 · Release #130 continúa NO-GO.**

## Hallazgo de aceptación corregido

El bloque 0R.27 ya podía verificar, con evidencia Sigstore/OCI y revisión humana de riesgo Ed25519, que exactamente un contenedor por cada servicio esperado `db`, `redis`, `backend` y `frontend` estuviera sano, en la red staging y con los dos IDs de imagen `sha256:<config-id>` firmados. Pero las consultas por **etiqueta de servicio** no detectaban un contenedor adicional con el mismo `com.docker.compose.project=sedeagro-staging` y una etiqueta de servicio desconocida. Un contenedor viejo u huérfano podría tener una publicación de puertos, una conexión de red externa o un volumen distinto, sin que el informe de los cuatro servicios lo mostrara.

## Nueva comprobación real de Docker, sólo lectura

Después de comprobar los cuatro servicios, el inspector de staging **en modo firmado/inmutable** ejecuta una quinta consulta independiente:

```text
docker container ls --all --quiet --no-trunc --filter label=com.docker.compose.project=sedeagro-staging
```

El inventario del proyecto debe contener **exactamente cuatro IDs completos, distintos, hexadecimales y de 64 caracteres**, y deben coincidir sin extras ni ausencias con los `Id` obtenidos de `container inspect` de cada servicio. No importa si el quinto contenedor está parado: `--all` lo encuentra y la aceptación falla. Tampoco se acepta una lista duplicada, un ID intercambiado, un resultado truncado ni una respuesta excesivamente grande.

El informe sólo marca `project_container_census_verified:true` después de superar esa consulta. La revisión de firma humana + OCI del bloque 0R.27 **exige explícitamente esa marca**; no puede aceptar un resultado parcial obtenido con el helper de validación aislada. Sigue verificando por duplicado los cuatro contenedores, los dos IDs OCI y los siete sujetos firmados. Se conserva el modo histórico de tags de desarrollo sin nuevos comandos para no romperlo silenciosamente.

## Pruebas y garantías no extendidas

Se agregan pruebas adversariales contra quinto contenedor, falta de uno, duplicados, ID sustituido, inventario malformado y ausencia de marca. Todas ejecutan dobles de Docker sólo en las pruebas unitarias; el código real seguirá utilizando el socket local y las mismas reglas de permisos. `tenant-rls` ejecuta ambas suites sobre el HEAD exacto y Chromium/PostGIS se revalida antes del merge.

La herramienta sigue sin crear, iniciar, eliminar, recargar ni conectarse a ningún contenedor por su cuenta; no modifica DNS, secretos, migraciones ni VPS. Este chequeo **no certifica** que el host no tenga otros contenedores sin la etiqueta del proyecto, ni constituye un despliegue/staging/producción autorizado. Faltan las firmas humanas, HTTPS staging real, restore/rollback externo, perfiles de los seis actores, 22 casos físicos móviles y SLO piloto. La decisión #130 sigue **NO-GO**.
