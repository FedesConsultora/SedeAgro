# P0 — Remediación verificada de dependencias backend (#210)

**Alcance:** resolución npm de `body-parser` y Zod en SedeAgro 0.1, manteniendo Express 4, Sequelize, PostGIS y los contratos del piloto. Base `main@6a5ade8dae88376aeee2e2f002d266d29afe29f4`. Prohibido producción sin #130.

## Diagnóstico confirmado

En el CI del SHA de main anterior se detectaron dos HIGH en backend runtime:

| Paquete | Bloqueo | Remediación |
| --- | --- | --- |
| `body-parser@1.20.8` | GHSA-27r3-jxmh-p828 (error de decoder ante trailing bytes en request comprimido) | `1.20.9` |
| `zod@3.25.76` | GHSA-mrhx-c7xc-m3w5 (acumulación no acotada de errores de colección) | `4.6.6` |

El frontend no presentó HIGH/CRITICAL en ese reporte. Se mantiene la política estricta de `npm audit`.

## Fuente de verdad de lockfiles

El runner público de GitHub Actions ejecutó `npm install`/ `npm update` **sin permisos de escritura en el repositorio**, usando el registro npm oficial. El job de preparación temporal `p0-lockfile-probe.yml` generó en un checkout efímero `backend/package.json`, `backend/package-lock.json` y `package-lock.json` raíz. Se recuperó el contenido exacto de esos tres archivos en fragmentos JSON cotejados por tamaño; no se calcularon hashes inventados ni se reescribieron campos `integrity` a mano.

La dependencia Zod queda fijada en `4.6.6` en backend, y ambos locks contienen SRI del registry para `zod@4.6.6` y `body-parser@1.20.9`. El lock de workspace incluye cambios transitivos/reconciliación propia de la resolución de npm; no copiar a producción sin `npm ci` y auditoría real.

El workflow temporal de recolección **se elimina del árbol final de este PR**. Sus commits históricos no constituyen un workflow de despliegue, ni emplearon secretos de la organización.

## Compatibilidad Zod 4

Zod 4 modifica el contrato de `z.record`. Los esquemas libres de maquinaria, insumos y configuración de plantillas migran de `z.record(z.any())` a `z.record(z.string(), z.any())`; conservan valores JSON anidados y `default({})`.

`backend/test/zod4Compatibility.test.js` verifica versiones, URL e integridad de paquetes en ambos locks; contratos de UUID, `coerce.number`, `coerce.date`, `enum`, `strict`, `flatten()`, `ZodIssueCode.custom`, array `min/max` y récords de metadatos. Los demás tests API y PostgreSQL/PostGIS siguen siendo **obligatorios**: especialmente errores HTTP 422, límites y permisos.

## Gates para cerrar

- `npm ci` en raíz y dentro de backend, sin modificar lockfiles ni saltar scripts de seguridad requeridos.
- `npm audit --omit=dev` desde backend y auditoría del frontend: zero HIGH/CRITICAL; baseline moderados revisada.
- Unidad backend/frontend, compilación React, pruebas PostGIS nonowner FORCE RLS, backup/restore, Chromium navegador, `production-images`, `dependency-security` exact-head: 4/4 PASS.
- Solo entonces merge **normal** a main preservando commits, con posmerge independiente 6/6 exacto.
- Staging aislado, Android/iOS reales, seguridad owner y despliegue siguen separadamente **NOT_RUN / NO-GO**.

No se toca DNS, host, Docker productivo, base real, secretos ni credenciales.