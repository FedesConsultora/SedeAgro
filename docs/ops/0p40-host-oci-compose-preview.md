# SedeAgro 0P.40 — Vista previa Compose sobre imágenes OCI firmadas locales

## Brecha que cierra

0P.35 validó en CI el overlay de producción con archivos sintéticos. 0P.39
permite verificar siete sujetos firmados e imágenes ya presentes por ID
inmutable en un Docker Linux local. Ninguno, por sí solo, demuestra que
**ese mismo host** renderizará el overlay sin cambios de topología.

Este bloque compone ambas verificaciones mediante
`scripts/inspect-host-oci-compose.mjs`. **Es un diagnóstico en solo
lectura; no concede GO ni prepara una ejecución de Compose.**

## Ejecución futura por operador autorizado

```sh
node scripts/inspect-host-oci-compose.mjs \
  --sha <SHA40_EXACTO_MAIN> \
  --evidence-dir <DIR_PRIVADO_0700_EXTERNO_AL_CHECKOUT>
```

Debe ejecutarse en Linux con checkout limpio `main`, `origin/main` y
SHA suministrado iguales, sin `DOCKER_HOST`, `DOCKER_CONTEXT`, opciones
TLS ni overrides de `COMPOSE_FILE/COMPOSE_ENV_FILES`. Se requieren
el TAR OCI, su recibo, las dos atestaciones GitHub y los cinco sujetos
firmados Syft/Trivy. No se provee modo para omitir firmas, Security Owner
o para usar un Docker remoto.

Secuencia obligatoria:

1. Reutiliza **íntegramente** 0P.39: comprobación de siete sujetos
   firmados, decisión de seguridad `release_go:false`, socket
   `unix:///var/run/docker.sock`, doble inspección por ID inmutable y
   etiqueta SHA; nunca carga o crea imágenes.
2. Relee el recibo de 0P.39, verifica que es archivo regular,
   no symlink ni hardlink, de tamaño acotado, que su digest coincide con
   la prueba firmada y que TAR, SHA, imágenes y config IDs no cambiaron.
3. Copia **solo YAML versionados** a un directorio temporal 0700 con
   `backend/.env` sintético y variables dummy. No lee `.env` productivo
   ni exporta secretos al subprocess.
4. Ejecuta exclusivamente `docker --context default compose -f
   <COPIA> config --no-env-resolution --format json` y su variante con
   el overlay OCI; nunca `up`, `run`, `start`, `create`, `build`,
   `pull`, `load` ni migraciones.
5. Reutiliza la comparación profunda de 0P.35. La diferencia permitida
   para backend/frontend es solo `build` → imagen de etiqueta SHA
   recibida y `pull_policy: never`. Se mantienen imágenes fijadas de
   PostGIS/Redis, redes (incluida fedes-net externa), volúmenes, roles,
   dependencias, puertos, healthchecks y demás claves sin cambios.
6. Compara los IDs recibidos de esa vista previa con los IDs del
   recibo verificado y los ya inspeccionados en el host.

## Prueba y aceptación

`node --test scripts/test/inspect-host-oci-compose.test.mjs`.
El workflow `host-oci-compose-preview.yml` ejecuta test aislado, sintaxis
y un render **real** del plugin Docker Compose v2 en un runner disposable,
sin .env real, sin Docker mutante ni credenciales. Los mocks de firmas
son **solo fixtures inyectados en tests**; la CLI real siempre verifica
atestaciones auténticas.

Éxito:
`HOST_SIGNED_OCI_COMPOSE_PARITY_READONLY_NOT_DEPLOYED`.

**Limitaciones de seguridad explícitas:**

- Las etiquetas Compose son mutables, aunque coincidan con los IDs en
  ese instante; esto **NO certifica la identidad en el instante de
  creación de un futuro contenedor** (TOCTOU). No ejecutar Compose
  `up` a partir de esta prueba.
- El script de deploy existente todavía construye imágenes desde
  fuentes y **NO** consume este reporte como admisión de producción;
  ello no se modifica ni se declara solucionado en este bloque.
- `release_go:false`, sin firma humana Security Owner, sin aceptación
  Operations/Data/Product, backup-restauración real, staging HTTPS,
  móviles offline físicos ni go-live. Matriz #130: **NO-GO**.
- No se tocó VPS, producción, staging, Docker local real del operador,
  DB, secretos ni redes. El render en CI es puramente declarativo.
