# 0R.46 — Admisión privada de evidencias QA móvil (MOB)

**11/11/2026 · SedeAgro 0.1 · Release #130: NO-GO.**

## Riesgo corregido

`scripts/validate-pilot-mobile-evidence.mjs` revisa un expediente **declarado por el operador** para los 22 casos MOB (Android Chrome e iOS Safari). El analizador de campos rechaza inconsistencias, pero antes la CLI hacía `statSync(source)` y `readFileSync(source)`: seguía symlinks, aceptaba archivos públicamente legibles y no enlazaba la inspección inicial con el archivo realmente leído. Además permitía suministrar rutas relativas.

Un expediente ajeno, enlazado o sustituido entre inspección y apertura podía aparecer como una entrada local aceptable. Eso no comprueba por sí mismo fraude de QA, pero aumenta el riesgo de confusión de evidencias durante una aceptación sensible.

## Nuevo contrato de lectura — sin conexiones externas

- El expediente debe ser un **archivo regular local, absoluto y canónico**, sin NUL, symlinks en la ruta ni rutas parentales reescritas.
- El archivo y su directorio inmediato deben ser propiedad del usuario operador (donde la plataforma expone UID) y no conceder permisos a grupo ni a terceros: **0600/0700** son la configuración recomendada. Archivo de entre 32 B y 64 KiB.
- Apertura con `O_NOFOLLOW | O_NONBLOCK | O_RDONLY`, comprobación por descriptor de `dev`/`ino` y estado previo; lectura acotada a **64 KiB + 1 byte** para rechazar crecimiento inesperado; comprobación posterior de identidad, tamaño y tiempos de modificación.
- No se modifican archivos. La CLI no imprime rutas, contenido sensible ni nombres de dispositivos ante un rechazo, y devuelve código **2**.
- `--template --sha SHA40 --origin ORIGEN_HTTPS` sigue generando una matriz **NOT_RUN** para completar *después* de ensayos físicos autorizados. `--file ABSOLUTO --sha SHA40` conserva la misma decisión `INCOMPLETE`, `BLOCKED` o `COMPLETE_FOR_HUMAN_REVIEW` según el contenido.

## Uso del operador (no ejecutado)

```bash
# Crear carpeta privada fuera del repositorio y de un servidor público.
umask 077
mkdir -p /ruta/privada/qa-movil
chmod 700 /ruta/privada/qa-movil

node scripts/validate-pilot-mobile-evidence.mjs \
  --template --sha SHA40_EXACTO --origin https://staging.ejemplo.test \
  > /ruta/privada/qa-movil/mob-evidence.json
chmod 600 /ruta/privada/qa-movil/mob-evidence.json

# Tras completar realmente el expediente en teléfonos físicos:
node scripts/validate-pilot-mobile-evidence.mjs \
  --file /ruta/privada/qa-movil/mob-evidence.json --sha SHA40_EXACTO
```

No colocar imágenes, GPS, credenciales, nombres ni datos privados en este JSON; usar referencias `QA-...` y conservar las evidencias reales en un almacén privado con custodia independiente. Una ruta canónica y permiso 0600 **no autentican** la persona ni demuestran la prueba física.

## Pruebas y aceptación de código

```bash
node --check scripts/validate-pilot-mobile-evidence.mjs
node --test scripts/test/pilot-mobile-evidence.test.mjs
```

Nuevas regresiones de proceso real validan archivo privado y la ausencia de GO, rechazo de lectura por symlink/parental compartido/file 0644/ruta relativa/no canónica, archivo truncado o sobredimensionado, carpeta en vez de archivo y errores sin filtración de contenido. Se conserva la matriz previa de 22 casos. La CI del job obligatorio `tenant-rls` ya ejecuta esta suite tanto en PR como en main.

## Límites

- Es **higiene de admisión local de un manifiesto**; no verifica capturas originales, ubicación GPS, identidad de dispositivo o ensayos Android/iOS, ni firma/hashes criptográficos de artefactos de campo. Un usuario con control del archivo puede falsificar su contenido: sigue siendo necesaria aceptación independiente.
- La comprobación previo/después detecta sustitución y muchas modificaciones concurrentes, no garantiza exclusión mutua con un proceso malicioso dueño del mismo UID.
- No toca VPS, staging operativo, PostGIS, Redis, API, contenedores, almacenamiento de fotografías ni equipos físicos.
- La salida más alta sigue siendo `COMPLETE_FOR_HUMAN_REVIEW`, **nunca** certificación automática, cierre de MOB o GO. También siguen pendientes HTTPS staging real, restore externo con RTO/RPO auténticos, rollback y firmas humanas.

**Decisión de producción: NO-GO.**
