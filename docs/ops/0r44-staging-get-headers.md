# 0R.44 — Política HTTPS efectiva en la respuesta GET de staging

**11/11/2026 · Release #130: NO-GO · Validación de solo lectura.**

## Brecha de aceptación

El smoke `scripts/verify-pilot-staging.sh` exigía HTTP 200, CSP estricta, HSTS y headers defensivos en **HEAD /**, pero los navegadores reciben normalmente **GET /**. Un proxy o regla de ubicación que trate HEAD y GET de manera distinta podía devolver una respuesta HEAD segura y una página HTML GET sin HSTS, con CSP permisiva o incluso una redirección. El anterior gate no revisaba esas cabeceras de la navegación real.

## Cambio y regresiones

- Se consulta **HEAD /** y **GET /** sin seguir redirecciones, sin desactivar TLS, sin proxy/curlrc heredado y con origen HTTPS explícito.
- Cada respuesta debe tener **una sola línea HTTP** y estado **200**. A cada método se le aplica la **misma validación estricta** de CSP, HSTS, Referrer-Policy, X-Frame-Options y X-Content-Type-Options, con rechazo de cabeceras duplicadas, directivas inseguras y respuestas ambiguas.
- GET se hace con `--dump-header - --output /dev/null`: no se graban bytes de la aplicación en disco. No se exponen cookies ni tokens ni se ejecuta JavaScript.
- Se preservan `/health`, `/health/ready`, `/health/revision`, la comprobación del SHA local y el 401 anónimo.
- El mock de `scripts/test/staging-smoke-guards.test.mjs` ahora distingue HEAD de GET. Nuevas regresiones rechazan GET 302/503, CSP con JavaScript inline, `object-src *` y HSTS ausente **aunque HEAD pase**.

## Verificación

```bash
bash -n scripts/verify-pilot-staging.sh
node --test scripts/test/staging-smoke-guards.test.mjs
```

`tenant-rls` ya ejecuta esta suite dentro del flujo estático en PR y main. La aceptación de una PR sigue requiriendo CI exact-head y controles independientes posmerge, sin bypass.

## Límites

El smoke realiza un **GET público de la raíz**, por lo que no se debe interpretar como una operación de cero solicitudes: únicamente es **de solo lectura**. La prueba con mocks valida el contrato del verificador, **no** prueba que exista un staging HTTPS autorizado accesible ni su certificado vigente, ni los IDs OCI del host, backups, RTO/RPO, rollback, sincronización en teléfonos físicos, seis perfiles o firmas humanas. Para validar el staging real se debe ejecutar el smoke desde un cliente externo con el SHA autorizado y después la revisión de assets y runtime firmados.

**Decisión de producción: NO-GO** hasta que la matriz del release #130 reciba evidencia operativa real y aprobaciones humanas. No se despliega, restaura ni modifica infraestructura con este bloque.
