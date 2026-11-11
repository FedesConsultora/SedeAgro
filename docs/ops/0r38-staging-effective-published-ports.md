# 0R.38 — Puertos publicados efectivos de Docker en staging OCI

**11/11/2026 · Release #130 continúa NO-GO.**

## Brecha concreta

`scripts/verify-staging-runtime.mjs` validaba `HostConfig.PortBindings`: que solo el frontend solicitase `127.0.0.1:4183:80/tcp` y db/redis/backend no solicitasen puertos publicados. Pero **no** contrastaba `NetworkSettings.Ports`, el mapa de bindings efectivos publicado por Docker.

Una inspección con `HostConfig.PortBindings` aparentemente correcta, pero con `NetworkSettings.Ports` que incluya `0.0.0.0:5432`, `0.0.0.0:6379`, `0.0.0.0:3001`, `[::]:80` o un puerto extra podría dar un resultado favorable de runtime, incluso con un contenedor marcado `healthy`. Para un staging aislado que comparte infraestructura con producción, esa divergencia debe **bloquear** la revisión OCI.

## Contrato corregido

El validador `validateStagingEffectivePorts(containers)` examina el mapa Docker de `NetworkSettings.Ports` de **los cuatro servicios** y se ejecuta por defecto en `validateStagingContainers`, también en el modo de revisión OCI firmada.

- **db, redis, backend:** no puede haber ninguna publicación real al host. `EXPOSE` sin publicación (`null` o arreglo vacío) sí es válido.
- **frontend:** única publicación permitida: `80/tcp` con exactamente un binding `HostIp=127.0.0.1`, `HostPort=4183`. Sin IPv6 `::`, `0.0.0.0`, segundo binding ni puertos adicionales publicados.
- La estructura de ports y los números de contenedor deben ser válidos. Si falta el inventario, si un binding aparece mal formado o si el mapa real contradice `HostConfig`, la revisión falla.
- No se expone valor alguno de `Env`, cadenas de conexión ni secretos, y el rechazo del CLI mantiene la salida redactada.

La revisión OCI firmada vuelve a ejecutar el inspector en dos pasadas. El nuevo control obliga a que **ambas** observen solamente bindings aprobados; una publicación ajena no puede aprobarse por coincidencia del SHA, healthcheck, labels, bridge interno ni imagen firmada.

## Regresiones nuevas

```bash
node --check scripts/verify-staging-runtime.mjs
node --test scripts/test/staging-runtime.test.mjs
```

Los casos adversariales cubren frontend en `0.0.0.0`, `::`, puerto distinto, doble binding, puerto extra, db/redis/backend publicados en loopback o interfaz pública, mapa ausente/mal formado y revisión OCI con publicación Redis no autorizada.

El contrato es **solo de inspección**: no crea ni edita mappings, contenedores, NAT, redes, VPS o bases de datos. No prueba reglas de firewall externas al daemon, DNS, un TLS edge autorizado, aceptación de campo ni backup off-VPS/rollback físico.

**No hay GO de staging ni de producción:** falta TLS real autorizado, verificación de restore externo con RTO/RPO, Android/iOS físicos, matriz de seis actores y firmas humanas de responsables. Release #130 continúa NO-GO.
