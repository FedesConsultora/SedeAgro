# 0R.31 — Inspector de staging: detectar escapes hacia el host

**11/11/2026 · SedeAgro 0.1 · Release #130 permanece NO-GO.**

## Hallazgo concreto

El inspector read-only `scripts/verify-staging-runtime.mjs` ya exigía los cuatro servicios correctos, healthchecks, volúmenes nominales de staging, red de proyecto y frontend loopback. Sin embargo, el examen de `HostConfig` únicamente descartaba `Privileged=true` y `NetworkMode` comenzando con `host`.

Un contenedor podría seguir teniendo `State.Health=healthy` y figurar sólo en `NetworkSettings.Networks[sedeagro-staging_staging_internal]` mientras `HostConfig` expone capacidades extra, namespaces del host, dispositivos, `ExtraHosts`, DNS modificado o binds a recursos de producción. El modo firmado OCI de staging no debe considerar aceptable ese contenedor, aunque el `Config.Image` coincida con el ID firmado.

## Verificaciones adicionales

Para **todos** los contenedores del proyecto, tanto en modo histórico como en modo OCI firmado, se exige:

- `HostConfig.Privileged=false`, `PublishAllPorts != true` y `NetworkMode` **igual exactamente** a `sedeagro-staging_staging_internal` (además de verificar `NetworkSettings.Networks`).
- Ausencia de `CapAdd`, `Devices`, `DeviceRequests`, `DeviceCgroupRules`, `Binds`, `ExtraHosts`, `Dns`, `DnsOptions`, `DnsSearch`, `Links`, `GroupAdd` y `CdiDevices`.
- `PidMode`, `IpcMode`, `UTSMode`, `CgroupnsMode` y `UsernsMode` solamente vacíos/default o `private`. `CgroupParent`, `Sysctls` y `Tmpfs` deben estar vacíos.
- `SecurityOpt` sin escapes `unconfined`; sólo se permite el endurecimiento explícito `no-new-privileges` además del valor Docker predeterminado.

Los fallos usan el error genérico `STAGING_RUNTIME_BLOCKED`; no imprimen los datos de `docker inspect`, `Config.Env` ni contraseñas. La inspección continúa siendo **read-only**.

## Pruebas

```bash
node --check scripts/verify-staging-runtime.mjs
node --test scripts/test/staging-runtime.test.mjs scripts/test/review-signed-staging-runtime.test.mjs
```

La CI `tenant-rls` existente ejecuta estas suites en PR y nuevamente sobre el merge final. Hay cobertura para los defaults Docker seguros y 25 intentos adversariales en ambos modos (OCI firmado y legacy), con intentos de desviar DNS, montar directorios ajenos, modificar capacidades, entrar a namespaces del host, pedir GPUs y publicar puertos extra.

## Alcance acotado / barreras restantes

El inspector no prueba el controlador de volumen real, que no exista otra infraestructura ajena al proyecto, la política del daemon Docker o la seguridad del host. Tampoco certifica que se haya desplegado staging, instalado HTTPS real, restaurado un backup externo o aceptado el piloto en Android/iOS. El registro real de claves Security Owner y las aprobaciones independientes siguen siendo obligatorias. **CI verde no es aprobación de producción** y el issue #130 permanece **NO-GO**.

No se inicia, recrea, importa ni elimina ningún contenedor; no hay cambios de VPS, secretos, migraciones, DNS o datos productivos.
