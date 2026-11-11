# 0R.30 — HTTPS real y health JSON específico en staging

**11/11/2026 · Release #130 permanece NO-GO.**

## Brecha corregida

El smoke read-only `scripts/verify-pilot-staging.sh` verificaba los headers de una respuesta HEAD pero no su status HTTP. Un 302/503 con headers de seguridad aparentes podía superar esa parte de la revisión. Para liveness y readiness sólo cotejaba 200: un fallback HTML del proxy, una página de mantenimiento o una respuesta cacheada con status 200 podían parecer un backend sano.

## Contrato nuevo, sin cambios de estado

- El HEAD HTTPS de la raíz debe contener una sola línea HTTP de estado, exactamente 200. Se rechazan los saltos 3xx, errores y respuestas concatenadas ambiguas.
- Las invocaciones curl empiezan con `-q` para ignorar configuraciones `~/.curlrc`; requieren `--proto '=https'`, excluyen proxies heredados con `--noproxy '*'` y nunca siguen redirecciones. TLS sigue validándose con curl por defecto, sin `--insecure`.
- `GET /health` debe devolver HTTP 200 y el cuerpo exacto `{"ok":true,"service":"sedeagro-backend"}`.
- `GET /health/ready` debe devolver HTTP 200 y el cuerpo exacto `{"ready":true}` que emite el controlador real tras autenticar contra PostgreSQL. Se bloquea JSON alterado y HTML genérico, aunque ambos respondan 200.
- Siguen siendo obligatorios HTTPS, HSTS >= 86400, CSP, demás headers, `/health/revision` con SHA40 exacto y `/api/v1/auth/me` anónimo 401.

## Validación y límites

`node --test scripts/test/staging-smoke-guards.test.mjs` prueba respuestas correctas, redirects, HEAD duplicado, liveness falseado y readiness falso. La CI `tenant-rls` ya ejecuta esta suite en PR y main. No se requieren credenciales, escritura, inicio de sesión, Docker, datos privados ni tocar infraestructura.

Esto **no prueba** que exista un staging operando, ni certifica aislamiento de datos real, certificados de dispositivos móviles, recuperación off-VPS o aprobación humana. El verificador comprueba el backend servido por el hostname consultado, pero no reemplaza la inspección de IDs OCI firmados del host. El despliegue a producción permanece bloqueado.

## Uso posterior con staging autorizado

```bash
bash scripts/verify-pilot-staging.sh https://staging.ejemplo.test SHA40_EXACTO
```

Se ejecuta sólo contra una URL de staging del proyecto, con el checkout local en ese HEAD. El éxito de este smoke es una evidencia parcial, nunca una señal automática de GO.
