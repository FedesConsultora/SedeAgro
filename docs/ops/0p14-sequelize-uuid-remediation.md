# 0P.14 — Sequelize / uuid 11.1.1: remediación auditada

## Alcance de la corrección
Sequelize 6.37.8 incorporaba uuid 8.3.2 y el advisory GHSA-w5hq-g745-h8pq (out-of-bounds buffer en v3/v5/v6).
Se fijó uuid 11.1.1 mediante overrides específicos de Sequelize en AMBOS package.json: raíz de workspaces y backend instalable en forma autónoma dentro de Docker.
Se evitó uuid 12+ ESM, incompatible con require de Sequelize v6. Se mantuvo Sequelize 6 sin actualización mayor.
Los dos package-lock.json preservan SHA512 real de uuid-11.1.1.tgz verificado en tres lockfiles públicos independientes:
sha512-vIYxrBCC/N/K+Js3qSN88go7kIfNPssr/hHCesKCQNAjmgvYS2oqr69kIufEG+O4+PfezOH4EbIeHCfFov8ZgQ==
Los jobs npm ci / Docker npm ci --omit=dev validan checksum contra npm registry.

## Evidencia ejecutable
- Test unitario de resolución CommonJS real de Sequelize, generación de UUIDV4 de modelo, v3/v5/v6 con buffers de salida demasiado cortos.
- PostGIS real CI con dos tenants sintéticos, rol runtime sin BYPASSRLS, FORCE RLS, Sequelize CREATE/UPDATE/DELETE/READ con UUIDV4 y aislamiento cross-tenant.
- Regresiones existentes: migra/seed, restore descartable, sesiones/cookies Chromium, evidencias/offline, imágenes de producción con SHA exacto.
- Auditoría LIVE npm audit de backend runtime y frontend: el baseline remediated con 0 moderate exige que el informe real muestre 0 critical/high/moderate. Si no, CI falla, no se acepta riesgo.
- El preflight sigue rechazando uuid 8.3.2, copia anidada, o falta de uuid parcheado bajo Sequelize. Ya no considera vulnerable a Sequelize 6.37.8 cuando depende solo de uuid 11.1.1.

## Límites / lanzamiento
Este bloque corrige dependencias del código. No acredita ambiente VPS ni TLS desplegado, rollback, recuperación de backup privado, QA Android/iOS físico, uso rural offline y firma humana GO/NO-GO. El cierre de #130 y la certificación de producción siguen pendientes.

Fuentes: https://github.com/advisories/GHSA-w5hq-g745-h8pq ; https://github.com/sequelize/sequelize/issues/18238 ; https://docs.npmjs.com/files/package.json/#overrides

Se requiere CI completo sobre PR HEAD exacto y CI independiente sobre SHA de main posmerge antes de cerrar #146/#137.