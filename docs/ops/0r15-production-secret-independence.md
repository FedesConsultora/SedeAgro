# 0R.15 — Independencia de los secretos de JWT y PostgreSQL en preflight

**Fecha:** 10/11/2026 · Coordinación #18 · Release #130 NO-GO.

## Hallazgo

`scripts/production-preflight.sh` ya exigía `JWT_SECRET` >=32 caracteres, credenciales de PostgreSQL owner/runtime >=24 y nombres de roles distintos. No comprobaba, sin embargo, que las **tres claves reales** fueran distintas. Una misma contraseña reutilizada para JWT, propietario o runtime permite que la filtración de un componente aumente los privilegios del atacante en otro. Las políticas de complejidad no detectan esa reutilización.

## Cambio aplicado

Después de validar sintaxis, permisos de los archivos privados y formato de las credenciales, pero **antes del escaneo npm, verificación OCI y cualquier operación Docker**, el preflight compara en memoria:

- `POSTGRES_PASSWORD != APP_DB_PASSWORD`.
- `JWT_SECRET != POSTGRES_PASSWORD`.
- `JWT_SECRET != APP_DB_PASSWORD`.

Ante igualdad el script falla con código 2 y mensaje genérico, sin interpolar ni imprimir valores secretos. No se exportan claves ni se agrega soporte de argumentos de bypass. Los controles de contraseñas seguras y la raíz de confianza OCI siguen obligatorios.

## Prueba reproducible sin entorno real

`node --test scripts/test/production-preflight.test.mjs` crea un repositorio Git sintético y dos archivos `.env` privados. Repite la evaluación con tres configuraciones separadas: mismo password entre roles DB, JWT=owner y JWT=runtime. Todas deben fallar antes de admisión de imágenes y no mostrar claves ni "PASS" en stdout. Al restaurar credenciales independientes, el script llega al **hard-stop de evidencia OCI** ya existente; independencia de claves nunca equivale a aprobación.

## Aceptación restante

Este control **no rota claves reales** ni inspecciona un VPS. Antes de producción, Security/Operations deben generar secretos únicos, provisionarlos por canal privado, comprobar mínimos privilegios DB, validar la aceptación de riesgo firmada, la promoción OCI por identidad exacta, pruebas de restore/rollback, staging y dispositivos Android/iOS físicos. El release #130 permanece **NO-GO**, sin firma humana ni deploy.
