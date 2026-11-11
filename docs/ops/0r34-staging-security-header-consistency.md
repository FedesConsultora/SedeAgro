# 0R.34 — Staging HTTPS: evitar PASS falsos con CSP/HSTS permisivos

**11/11/2026 · Release #130 continúa NO-GO.**

## Brecha validada en código

`scripts/verify-pilot-staging.sh` comprobaba la presencia de `script-src 'self'` mediante un `grep` de subcadena. Una respuesta con `script-src 'self' 'unsafe-inline'` o `script-src 'self' 'unsafe-eval'` también podía pasar. De forma similar, la regex de HSTS aceptaba valores ambiguos que contuvieran `max-age=86400` aunque la directiva real fuera inválida o estuviera duplicada. Las cabeceras duplicadas se pueden interpretar de forma distinta según navegador, proxy y servidor.

Esto es especialmente relevante porque la aceptación de staging usa un HTTPS edge independiente de Nginx interno: un `HTTP 200` no demuestra que la política de seguridad enviada al navegador coincida con la revisada.

## Contrato nuevo (solo lectura)

El smoke requiere **exactamente una** cabecera de CSP, HSTS, Referrer-Policy, X-Frame-Options y X-Content-Type-Options. Rechaza encabezados continuados/ambiguos y contradicciones incluso si una copia parece correcta.

La CSP se divide por directivas y **rechaza duplicados**, exigiendo los valores completos, no subcadenas:

- `default-src 'self'`; `script-src 'self'` **sin** `unsafe-inline`, `unsafe-eval`, orígenes adicionales, comodines ni nuevas políticas contradictorias.
- `connect-src 'self'`, `worker-src 'self'`, `base-uri 'self'`, `form-action 'self'`.
- `object-src 'none'` y `frame-ancestors 'none'`.
- Las directivas complementarias conservan su configuración actual de Nginx. En particular, `style-src 'self' 'unsafe-inline'` no es equiparable a permitir JavaScript inline.

HSTS debe consistir exclusivamente en `max-age=<segundos>` con un número decimal válido de hasta nueve dígitos y **al menos 86400 segundos**. Se rechazan sufijos malformados, overflow numérico, directivas duplicadas e `includeSubDomains` no autorizado en la política del piloto.

La respuesta sigue requiriendo status HTTPS 200 único, `/health` y `/health/ready` con JSON exacto, SHA40 del backend, anónimo 401 y curl sin redirecciones/proxy ni configuración ambiental. Los errores se redactan y no leen credenciales, dispositivos ni datos privados.

## Evidencia de regresión

```bash
bash -n scripts/verify-pilot-staging.sh
node --test scripts/test/staging-smoke-guards.test.mjs
```

La suite amplía el mock de HTTPS con la CSP real de Nginx y ataques de bypass por `unsafe-inline`, `unsafe-eval`, orígenes externos, `script-src` duplicado, falta de controles `worker-src`/ `connect-src`, HSTS adulterado y múltiples copias de cabeceras de seguridad. Un valor `MAX-AGE=86400` válido sigue siendo aceptado.

La CI `tenant-rls` del HEAD exacto de PR y, por separado, del merge a `main`, ejecuta estas pruebas; otros jobs validan Chromium/PostGIS, offline y artefactos OCI.

## Limitaciones operativas

Este gate no prueba la existencia de un staging autorizado, certificados desplegados en un host real, validez del DNS público, aceptación física Android/iOS, backup/restore externo ni aprobación humana. La emisión de headers del servicio HTTPS consultado es una evidencia **parcial**, no un `GO` de producción.

**No se modifica Nginx, infraestructura, base de datos, tokens, archivos privados, contenedores ni VPS. Release #130 permanece NO-GO.**
