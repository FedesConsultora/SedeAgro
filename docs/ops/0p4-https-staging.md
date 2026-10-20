# 0P.4 — Puerta HTTPS y readiness remoto para staging (sin despliegue)

## Problema resuelto

El verificador externo anterior aceptaba `/health` (proceso vivo) sin probar disponibilidad del rol runtime PostgreSQL. Además, la plantilla del proxy TLS no declaraba HSTS, y el Nginx interno sobrescribía `X-Forwarded-Proto: https` con su `$scheme` interno `http`.

## Contrato y cambios

- El vhost HTTPS de `sedeagro.fedes.ai.conf` declara `Strict-Transport-Security: max-age=86400` como piloto **de un día**, sin `includeSubDomains` ni `preload`. No se presupone que el proxy de producción tenga todavía instalada esta configuración.
- El proxy `frontend/nginx.conf` utiliza un `map` en ámbito HTTP para reenviar el esquema original `https` cuando el edge confiable lo fija, manteniendo `$scheme` para otros valores. **La cabecera debe provenir de un proxy de confianza dentro de la red privada**. No publicar el Nginx interno ni la API en una interfaz externa directa.
- `scripts/verify-pilot-staging.sh` sigue siendo **solo lectura**: exige origen HTTPS absoluto sin credenciales ni rutas; comprueba el SHA exacto del checkout local, CSP/headers, HSTS `max-age` mínimo de 86400, liveness `/health` 200, **readiness real `/health/ready` 200**, y `/api/v1/auth/me` sin credenciales 401. Un 200 de liveness nunca sustituye la prueba de base.
- CI agrega pruebas sintéticas con ejecutables `curl` y `git` simulados para verificar casos positivos y rechazos de HSTS ausente/corto, 503 en readiness, 200 no autorizado, HTTP/orígenes inválidos y SHA distinto. El workflow conserva sus pruebas reales PostgreSQL/PostGIS, Chromium y `nginx -t`.

## Secuencia obligatoria para una validación auténtica

1. Instalar la configuración del vhost en **staging** únicamente tras verificar ruta/certificado TLS y autorización de operación. Revisar la cadena de certificados, permisos y host correcto; no aplicar el dominio productivo como origen de staging por accidente.
2. Confirmar `nginx -t` en el edge real y obtener encabezados desde un cliente externo. Revisar HSTS y que el proxy pase `X-Forwarded-Proto` de forma controlada.
3. Usar el checkout Git correspondiente al SHA aprobado y ejecutar:

```bash
bash scripts/verify-pilot-staging.sh https://staging.sedeagro.example SHA40_APROBADO
```

4. Ejecutar después el cotejo byte a byte de assets frontend contra un artefacto **del mismo SHA** mediante `scripts/verify-deployed-staging.mjs`. El smoke de headers no constata versión backend ni migraciones.
5. Realizar pruebas autenticadas RLS de dos tenants y roles, cookies seguras/CSRF, backup y restore real, latencias de filtros, captura offline con dispositivos y go/no-go firmado. Ninguna de esas aceptaciones se reemplaza con un 200 de readiness.

## Límites documentados

- La prueba `/health/ready` comprueba la conexión runtime; no asegura que las migraciones estén completas, que un worker de reportes esté activo, ni que los flujos offline o RLS multiempresa funcionen desde staging.
- La cabecera HSTS de ejemplo **no acredita** configuración TLS aplicada ni vigencia de certificado. El `map` mejora el transporte del esquema entre saltos, no reemplaza un modelo de confianza del proxy.
- CI y mocks ejecutan una simulación útil del validador, no una conexión a un servidor remoto de campo.
- Sigue siendo necesaria aprobación explícita de despliegue productivo: preflight de 0P.1, respaldo probado de 0P.3, pruebas Android/iOS físicas, rendimiento #105, accesibilidad #86 y plan de rollback.
