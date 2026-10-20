# 0P.9 — Inventario bloqueante de regresiones en las vulnerabilidades moderadas

## Alcance técnico y estado del GO

Este bloque protege el candidato de nuevos avisos moderados en dependencias productivas del backend mientras se evalúan las seis vulnerabilidades remanentes de 0P.8. **No las corrige por sí mismo, no acepta sus riesgos y no autoriza deploy.** El issue #137 permanece abierto hasta remediación o aceptación firmada por el responsable de release con revisión de alcanzabilidad.

La fuente de verdad es el resultado vivo de `npm audit --omit=dev --json` sobre los mismos `backend/package*.json` que emplea Docker, contrastado con `backend/package-lock.json`. No se toman conteos desde esta documentación.

## Dependencias concretas del lockfile del candidato 0P.8

| Paquete instalado | Versión | Cadena / motivo de revisión |
| --- | --- | --- |
| `umzug` | 3.8.3 | Dependencia de migración ejecutada dentro de la imagen backend; no se puede eliminar sin cambiar el flujo de migraciones |
| `@rushstack/ts-command-line` | 4.19.1 | Transitiva de `umzug`; su dependencia fija `argparse ~1.0.9` |
| `argparse` | 1.0.10 | Transitiva de `@rushstack/ts-command-line`, depende de `sprintf-js ~1.0.2` |
| `sprintf-js` | 1.0.3 | Aviso de denegación de servicio por precisión de formato sin límite; alcanzabilidad desde entradas externas no demostrada |
| `sequelize` | 6.37.8 | ORM del backend en ejecución; depende de `uuid ^8.3.2` |
| `uuid` | 8.3.2 | Aviso por chequeo de límites de buffer en v3/v5/v6; no se presume que todas las rutas del ORM sean inocuas |

Estos seis nombres no implican seis fallos raíz independientes: cuatro corresponden a la misma cadena de `umzug` y dos a la de `sequelize`. Que una cadena se use principalmente para migraciones no constituye prueba de no-explotabilidad, ya que el paquete todavía forma parte de la imagen productiva.

## Gate nuevo y evidencia exigida

- `scripts/security-moderate-baseline.json` registra nombres, versiones del lock y títulos sanitizados de avisos directos. Su estado es explícitamente `unaccepted-for-release`.
- `scripts/security-moderate-policy.mjs` rechaza paquetes moderados nuevos, aumento del total respecto de seis, cambios de versión de un paquete aún vulnerable, nuevos títulos de aviso directo, informes incompletos y deadline caducado.
- `scripts/security-audit-report.mjs` rechaza incongruencias entre severidades de `metadata` y el inventario de paquetes, incluidos resultados aparentemente vacíos. Sigue bloqueando todo `high` o `critical` en backend runtime y frontend build.
- La fecha del inventario es **20 de noviembre de 2026 inclusive (UTC)**. El 21/11/2026 el control bloquea nuevos candidatos hasta reevaluar y actualizar la política con evidencia y revisión explícita. La fecha no equivale a una aprobación temporal para producción.
- El workflow siempre genera diagnóstico de `npm audit fix --package-lock-only --ignore-scripts` en directorios descartables, sin push automático ni cambios en el checkout. Un cambio compatible potencial aún requiere revisión semántica y `npm ci`/Docker/migraciones/RLS/Chromium.
- Los tests ejecutan casos favorables y adversarios: nuevos paquetes o CVE en paquete ya listado, aumento del conteo, baja de CVE, versión cambiada, informe parcial, suplantación de severidad, expiración y prohibición de dar por aceptado un riesgo abierto.

## Requisitos pendientes antes de cerrar #137 o un GO

1. Obtener advisories actuales del registro npm (identificador, rango vulnerable/fixed, vías transitivas, severidad, alcance del código API/migraciones).
2. Aplicar únicamente actualizaciones compatibles realmente probadas y observar descensos auditados por CI, con lockfiles e integridad intacta. Mayores y sustituciones de ORM/herramienta de migración van en PR separados con pruebas específicas.
3. Si quedase alguna moderada: responsable concreto de riesgo, mitigaciones operativas, plazo, evidencia de no alcanzabilidad si se alega y **aprobación explícita humana**; no inferirla de `SUCCESS`.
4. Repetir los cuatro jobs de GitHub Actions sobre el SHA exacto premerge y CI independiente postmerge. Validar fuera de CI TLS, staging, restauración privada real, físico Android/iOS, rural offline y rollback con evidencia de release.

Ninguna modificación de VPS, producción o credenciales forma parte de este bloque.
