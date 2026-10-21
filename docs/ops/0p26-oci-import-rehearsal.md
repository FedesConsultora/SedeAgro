# 0P.26 — Ensayo de importación OCI en almacén limpio y runner independiente

## Riesgo que cierra

En 0P.25, SedeAgro exporta `docker save` con las dos imágenes backend/frontend y un recibo SHA256, comprueba configuración, tags, capas e índice OCI; preserva el par solamente en los `push` a `main`. Pero **no demostraba que otra instalación Docker pudiera aceptar efectivamente esos bytes**. La simple lectura del archivo no garantiza su importación ni que los IDs restaurados sean los esperados.

0P.26 incorpora dos ensayos de `docker image load --input` **exclusivamente en runners descartables de GitHub Actions**, sin modificar el entorno real, publicar imágenes o arrancar la aplicación.

## Alcance funcional

**Carril productor (premerge y posmerge, job `production-images`):**

1. Construye las imágenes productivas con tags inmutables `sedeagro-backend-rc:<HEAD>` y `sedeagro-frontend-rc:<HEAD>`, ejecuta verificaciones de frontend y las exporta en TAR como 0P.25.
2. Ejecuta `scripts/oci-release-bundle.mjs create`/`verify`, calculando los SHA256 de las capas, configuraciones y TAR entero **antes de cualquier eliminación/importación**.
3. En `scripts/ci-oci-import-rehearsal.mjs --mode replace`, inspecciona ambas imágenes construidas mediante Docker. Exige exactamente el tag, config ID, label `org.opencontainers.image.revision`, plataforma Linux/amd64, `rootfs.diff_ids` y variable `SEDEAGRO_BUILD_SHA` de backend.
4. Elimina únicamente esos **dos tags exactos del runner CI** mediante `docker image rm --no-prune`; no elimina imágenes arbitrarias ni recursos de producción. Comprueba que ya no aparezcan en `docker image ls`.
5. Ejecuta `docker image load --input` con el TAR previamente verificado, y exige que los dos tags, IDs, capas, revisión OCI y SHA de backend coincidan de nuevo. El gate falla si algún archivo o imagen es incorrecto. Este ensayo conserva el TAR y recibo para `actions/upload-artifact@v4` solo en `main`, con la misma retención de siete días.

**Carril receptor (solo posmerge de `main`, job `offline-image-import`):**

1. GitHub Actions reserva **otro runner limpio**, con su propio Docker daemon. Este job depende del éxito de `production-images`.
2. Hace checkout del `github.sha` exacto, sin conservar credenciales Git innecesarias, y descarga de ese mismo run el artefacto `sedeagro-oci-<SHA>` a su directorio temporal.
3. Vuelve a ejecutar `scripts/oci-release-bundle.mjs verify` para comparar **el archivo descargado** y su recibo: SHA256 íntegro del TAR, las dos configuraciones de imágenes y todas sus capas.
4. La invocación `--mode fresh` verifica que ninguno de los dos tags exactos exista en el Docker daemon de destino, ejecuta `docker image load --input` y reconsulta cada ID/configuración, su etiqueta de revisión y su lista `RootFS.Layers`. Un daemon con tags preexistentes o resultados discrepantes bloquea la aceptación.
5. Emite `CI_OCI_IMPORT_REHEARSAL_VERIFIED_NOT_DEPLOYED` con los IDs y SHA de archivo, y deja todos los flags de firma/registry/deploy en `false`.

El receptor no necesita secreto de producción, base de datos, TLS, VPS ni acceso al registry. No ejecuta `docker run`, `docker compose`, `docker start`, `docker push` o `docker pull`: **la importación no arranca contenedores ni publica puertos**.

## Protección fail-closed y pruebas

`scripts/test/ci-oci-import-rehearsal.test.mjs` incluye pruebas adversarias con Docker simulado para validar: bloqueo antes de Docker si falla el recibo; ausencia previa exigida en runner fresco; coincidencia exacta de imágenes antes de retirarlas en el productor; rechazo ante error de eliminación, importación parcial, tag/ID alterado, SHA, plataforma o capas incorrectas; comandos restringidos a `image ls`, `inspect`, `rm` exacto y `load`; negativa en CLI fuera de GitHub Actions y sin fuga de variables de entorno. Se ejecutan en `tenant-rls`.

Los checks de CI ahora son **4 en PR** (los cuatro jobs tradicionales) y **5 en el nuevo `main`** (`offline-image-import` se agrega después de `production-images`). Se exige el resultado `SUCCESS` y SHA exacto de cada job/ejecución, no un SHA antiguo.

## Qué evidencia y qué no

- Prueba que el **paquete binario producido por CI se puede importar desde el TAR**; el carril receptor se ejecuta en otro runner y no reutiliza las imágenes ni la caché Docker del productor. La igualdad postimportación se basa en config ID SHA256, tags, labels y rootfs diff IDs, además del hash del TAR completo.
- **No demuestra que las imágenes arranquen como una aplicación completa en staging o producción**. Los arranques de smoke separados del productor siguen siendo pruebas de CI. Tampoco certifica una arquitectura CPU distinta, un host físico de la empresa o compatibilidad con configuraciones privadas.
- El recibo no está firmado. Ni este ensayo ni Docker image ID son un digest de imagen confiable en un registry. Un atacante con control del run/artefacto podría reemplazar ambos archivos; verificar la procedencia desde GitHub sigue siendo responsabilidad del operador.
- Un resultado verde no autoriza `docker load` en el VPS, corte de tráfico, migraciones, cambio de secrets, DNS o certificados. Estas acciones necesitan autorización y aceptación **separadas**.
- No certifica backup privado fuera del VPS, tiempos RTO/RPO, RLS de staging real, HTTPS/TLS, dispositivos Android/iOS físicos ni firmas de seguridad/datos/operación.

**Matriz #130:** permanece **NO-GO** hasta que esas verificaciones y aceptaciones externas se documenten.

## Comprobaciones de cierre

Se exige ejecución premerge exact-head con `tenant-rls`, `browser-offline`, `production-images` (incluye import `replace`) y `dependency-security` en `completed/success`. Fusionar por merge normal preservando commits lógicos y sin colisiones sobre `main`. Exigir una ejecución independiente `push/main` con los **cinco** jobs en `completed/success` para el nuevo SHA, confirmando que `offline-image-import` realmente descargó y restauró el artefacto de ese mismo run. No se aceptan pruebas de importación simuladas como sustituto de Docker real.
