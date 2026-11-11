# 0R.36 — Chromium CI sin dependencia DNS de apt para ejecutar E2E

**11/11/2026 · SedeAgro piloto 0.1 · Release #130 continúa NO-GO.**

## Incidencia comprobada en los logs

PR #319 `43037351151` falló en `browser-postgis` y `browser-offline` **antes de cualquier prueba funcional** por:
`Temporary failure resolving 'azure.archive.ubuntu.com'` al instalar los paquetes de sistema que invoca `npx playwright install chromium --with-deps`. El paso de instalación finalizó con `Failed to install browsers`, código 100. Los pasos de PostgreSQL/RLS, seguridad e imágenes fueron exitosos. El siguiente workflow de main `43039035550` reprodujo al menos la incidencia de navegador offline.

`--with-deps` mezcla dos operaciones externas: instalación del binario Chromium pinneado y paquetes Ubuntu con `apt`. La máquina `ubuntu-24.04` es compatible con Playwright `1.58.2`, pero el mirror puede fallar sin relación con el proyecto.

## Implementación

Los jobs **sin cambiar de runner**, manteniendo `ubuntu-24.04` y `playwright@1.58.2`, ahora hacen:

```bash
npx playwright install chromium
node scripts/ci-verify-playwright-chromium.mjs
```

- El primer paso descarga **el Chromium real asociado a la versión exacta de Playwright**, sin invocar `apt`.
- El siguiente paso lanza **Chromium de verdad**, crea una página, visita un documento `data:text/html`, lee el DOM, verifica una versión normal de Chromium y cierra el proceso. El error es fatal, sin `continue-on-error`, si hay librerías faltantes, binario no ejecutable o DOM roto.
- Todos los E2E de cookies/sesiones, PostGIS, evidencias, bandeja de coordinación y el flujo offline de IndexedDB siguen **obligatorios y sin modificaciones**. El preflight se ejecuta antes.
- Los tests estructurales existentes de runner/Browser se actualizan y se agrega un test nuevo de orden de pasos, binario real y política de fallo cerrado. `tenant-rls` ejecuta estos tests en cada PR y `main`.

No se reemplaza Chromium por un mock ni se deshabilita ningún check. La ejecución verdadera en CI es obligatoria para obtener `SUCCESS`. Si al `ubuntu-24.04` concreto le faltan librerías dinámicas, el preflight falla visiblemente y deberá adoptarse una imagen CI de navegador con dependencias preinstaladas y verificación de procedencia; **no se puede interpretar la descarga exitosa como aceptación**.

## Validación / límites

```bash
node --check scripts/ci-verify-playwright-chromium.mjs
node --test scripts/test/ci-chromium-runtime.test.mjs
node --test scripts/test/pilot-ci-runner-compat.test.mjs scripts/test/postgis-browser-workflow.test.mjs
```

La única evidencia de aprobación del navegador es que su job **termine** con `SUCCESS` ejecutando las suites reales. Los tests de contrato y los checks de RLS no sustituyen esa validación.

Este bloque modifica únicamente la orquestación CI, test de preflight y contratos. No accede a staging ni VPS reales, no despliega ni ejecuta migraciones sobre datos reales.

**Faltan todavía HTTPS staging autorizado, restore fuera del VPS/rollback con RTO/RPO, pruebas físicas Android/iOS, aceptación por actor y firmas independientes. NO-GO.**
