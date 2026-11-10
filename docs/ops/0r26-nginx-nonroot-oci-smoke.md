# 0R.26 — Nginx OCI firmado: chequeo con usuario no privilegiado

**Fecha:** 10/11/2026 · Coordinación #18 · Release #130 **NO-GO**.

## Fallo reproducido en CI independiente

En `main@bf422f2787c19779eadbddd82910de7f8c0cf39b`, el run `428? ` posterior al merge #308 (concretamente el run `42902368114`) verificó las firmas Sigstore/OIDC, los siete sujetos OCI/Syft/Trivy, el TAR, los dos IDs y capas importados y el Compose productivo con imágenes inmutables. El backend Node/Express pasó con `/health`, revisión SHA y readiness 503 sin PostGIS. El único fallo fue el frontend Nginx con `exit=12 stage=syntax`. Los tmpfs privados para PID/cache/log no bastaron.

## Cambio acotado

El smoke de la imagen frontend se ejecuta con `docker container run --user nginx`: el usuario **no privilegiado que ya contiene la imagen**. Con el proceso anterior como root y `--cap-drop=ALL`, Nginx puede no tener capacidad para cambiar el grupo del usuario configurado. Se prueba sintaxis directamente con el usuario sin intentar esa transición privilegiada.

Se mantienen obligatorios `--network=none`, `--read-only`, `--pull=never`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, límites de recursos, tmpfs acotados, ausencia de puertos y mounts del host, y referencias `sha256:<config-id>` vinculadas al TAR firmado. El contenedor se destruye siempre; no hay staging real, DB ni despliegue.

Si persiste algún fallo, el reporte solamente podrá registrar la categoría segura `privilege` (además de `upstream`, `filesystem`, `config` o `syntax`) y código de salida; nunca volcará stderr de Nginx, secretos o rutas internas. Las pruebas negativas comprueban selección del usuario, flags de aislamiento y categorías que no imprimen información privada.

## Aceptación

La PR debe aprobar sus verificaciones sobre el HEAD exacto. **Además**, el `offline-image-import` del segundo runner independiente, posterior a la fusión, debe arrancar backend y validar Nginx real desde los mismos IDs OCI importados. Si falla, se mantiene bloqueada la certificación técnica; ninguna prueba se elimina ni sustituye por un mock de resultado exitoso.

No se modifica el deploy de producción, el trust registry, roles, migraciones, DNS ni VPS. Falta firma humana real, staging aislado autorizado, restore/rollback externo, móviles físicos y aprobación de Producto/Seguridad/Operaciones/Datos. `#130` sigue NO-GO.
