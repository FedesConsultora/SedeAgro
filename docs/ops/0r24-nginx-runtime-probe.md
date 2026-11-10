# 0R.24 — Nginx firmado: prueba de proceso OCI aislado y archivos efímeros

**Fecha:** 10/11/2026 · Coordinación #18 · Release #130 **NO-GO**.

## Incidente verificado

El primer ensayo de ejecución sobre las imágenes importadas del TAR OCI firmado (#305) falló en CI de `main@2e56bf61` después de superar las firmas OIDC, la integridad del TAR, los IDs y las capas RootFS, y la resolución real de Docker Compose. La siguiente ejecución, con diagnósticos restringidos (#307), registró:

```text
BLOCKED OCI runtime smoke: frontend process exit=12 stage=syntax
```

**El backend Express había pasado** sus comprobaciones reales de `/health=200`, `/health/revision=SHA` y `/health/ready=503` ante la base inaccesible. El fallo ocurrió en `nginx -t` dentro del contenedor del frontend, **no** en la firma de artefactos ni en la transferencia.

## Corrección de la prueba

Se conserva el objetivo de aislamiento del runner receptor: `--network=none`, `--pull=never`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, sin puertos, volúmenes del host ni datos productivos. Para que Nginx pueda verificar su configuración sin escribir en la raíz de la imagen, se montan tmpfs privadas y acotadas en:

- `/tmp` para diagnósticos temporales (ya existía).
- `/var/cache/nginx` para los directorios temporales de Nginx, `mode=1777`.
- `/run` (destino real de `/var/run` en Alpine), `mode=1777`.
- `/var/log/nginx` para entradas temporales de registro, `mode=1777`.

Si `nginx -t` sigue fallando, el stderr queda **sólo** en el tmpfs del contenedor y se clasifica por patrones acotados `upstream`, `filesystem`, `config` o `syntax` sin mostrar rutas, secretos ni el contenido de la configuración. El CLI presenta únicamente el servicio, código de salida y categoría, no texto crudo de Docker. Esto permite identificar cualquier incompatibilidad restante y mantiene la prueba estricta.

## Aceptación necesaria

La PR debe superar tests de Node y del navegador sobre su SHA exacto. Pero el criterio decisivo es el **runner independiente posterior al merge**: no declarar éxito si no ejecutó realmente ambos procesos firmados, validó `nginx -t` y verificó la limpieza de los contenedores temporales.

No se cambia `docker-compose.yml`, el deploy productivo ni el registro de claves humanas. No se ejecuta nada en un VPS. Aunque la CI finalmente sea verde, siguen pendientes un staging HTTPS aislado, restore y rollback externos, firma humana y pruebas de campo; #130 permanece **NO-GO**.
