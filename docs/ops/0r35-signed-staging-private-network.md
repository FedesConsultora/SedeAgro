# 0R.35 — Red Docker interna y exclusiva en staging OCI firmado

**11/11/2026 · Release #130: NO-GO.**

## Hallazgo real

El inspector de staging comprobaba que cada contenedor tuviera exactamente una interfaz llamada `sedeagro-staging_staging_internal` y `HostConfig.NetworkMode` con ese mismo nombre. Esas propiedades de los contenedores **no demuestran** que el objeto de red Docker exista con `Internal=true`, ni que sea un bridge privado del proyecto, ni que no haya contenedores externos conectados.

Un bridge compartido, `Internal=false`, un driver distinto o un quinto endpoint no deben dar un resultado favorable de revisión firmada.

## Verificación nueva de solo lectura

`scripts/verify-staging-runtime.mjs` ejecuta, únicamente en modo de imágenes OCI inmutables y **después** de comprobar cuatro contenedores y los volúmenes locales:

```text
docker network inspect --format '{{json .}}' sedeagro-staging_staging_internal
```

La respuesta debe tener:

- Nombre exacto, ID Docker hex de 64 caracteres, `Driver=bridge`, `Scope=local` y `Internal=true`.
- `Attachable=false`, `Ingress=false`, sin network configuration-only ni opciones no esperadas de driver.
- Labels `com.docker.compose.project=sedeagro-staging` y `com.docker.compose.network=staging_internal`.
- Un censo de **exactamente cuatro** contenedores conectados (db, redis, backend, frontend); sin endpoints extra, huérfanos ni ajenos.
- Coincidencia de ID y nombre de cada contenedor con el censo firmado ya validado y coincidencia de `NetworkID` y `EndpointID` entre `docker network inspect` y `docker container inspect`.

Solo después produce `project_network_inventory_verified:true` y `project_network_id`. `review-signed-staging-runtime.mjs` exige esta evidencia en sus **dos** inspecciones y rechaza si el ID de la red cambia entre ellas.

El modo legacy no invoca esta nueva inspección; **nunca** puede emitir la bandera de revisión OCI firmada.

## Pruebas de regresión

```bash
node --check scripts/verify-staging-runtime.mjs
node --test scripts/test/staging-runtime.test.mjs scripts/test/review-signed-staging-runtime.test.mjs
```

Los tests adversariales simulan:

- Una red con `Internal=false`, drivers overlay/macvlan, scope swarm, `Attachable` o `Ingress` activos.
- Proyecto/etiqueta incorrectos, opciones de driver alteradas, ID falso y red renombrada.
- Contenedor adicional, ausente o sustituido; divergencia de nombres, `NetworkID`, `EndpointID`, IDs completos o conexiones duplicadas.
- Eliminación de evidencia de red y sustitución de la identidad de la red entre las dos rondas de revisión firmada.

Se preservan verificaciones anteriores de nombres/privilegios del host, identidad inmutable de imágenes, censo completo de contenedores, volúmenes locales y proceso de firma humana.

## Límites

Esta verificación no prueba que el host, daemon Docker, firewall, túnel HTTPS o sistema de archivos físico sean confiables, ni que otras redes no se solapen por direccionamiento. Es read-only y **no** crea, conecta, desconecta, levanta ni borra redes, contenedores o datos. Tampoco acredita staging real autorizado, backup off-VPS y restauración independiente, rollback medido RTO/RPO, ni aceptación física Android/iOS o firmas finales de Seguridad/Operaciones/Datos/Producto.

**No se concede despliegue ni GO productivo. Release #130 continúa NO-GO.**
