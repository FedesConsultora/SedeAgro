# SedeAgro 0P.39 — Verificación OCI firmada, host Linux en solo lectura

## Objetivo y frontera

0P.37 verificó en un runner independiente de GitHub que Docker crea dos
contenedores **detenidos** desde los IDs inmutables del TAR OCI. 0P.38
prepara exclusión entre invocaciones del deploy productivo. Faltaba una
verificación independiente de que los bytes OCI transportados están **ya
presentes** en un daemon Docker local, sin arrancar contenedores ni
confundir una etiqueta mutable con la identidad de la imagen.

`scripts/inspect-host-oci-images.mjs` es un **diagnóstico offline del
host con comprobación criptográfica online de firmas GitHub**; en ninguna
circunstancia concede permiso para desplegar.

## Contrato

Entrada estricta:

```bash
node scripts/inspect-host-oci-images.mjs \
  --sha <GIT_SHA40_DEL_CANDIDATO> \
  --evidence-dir <DIRECTORIO_0700_PRIVADO_FUERA_DEL_CHECKOUT>
```

El directorio debe contener `oci/sedeagro-images-<SHA>.tar` y
`oci/sedeagro-images-<SHA>.json`, y `security/` con los cuatro
informes Syft/Trivy más el recibo de seguridad del **mismo SHA**.
Ambos subdirectorios son privados y pertenecen al operador Linux.
No guarda ni muestra tokens, credenciales, salida sin filtrar de Docker,
datos de bases o certificados.

Pasos (si falla uno, ningún paso posterior se considera aceptado):

1. El checkout local está limpio, en `main`, y coincide exactamente
   con `origin/main` y el SHA solicitado; rechaza ref viejo.
2. Comprueba archivos/directorios canónicos, propietarios y permisos
   privados, sin symlinks/hardlinks para el recibo.
3. Verifica el TAR completo, su receipt y las dos atestaciones
   GitHub OIDC/Sigstore con `gh attestation verify`, identidad de
   workflow, source ref `main` y SHA exacto.
4. Verifica separadamente los **cinco** informes Syft/Trivy firmados
   y el inventario de riesgo, manteniendo `release_go=false`,
   `EXTERNAL_SECURITY_REVIEW_REQUIRED` y 0 HIGH/CRITICAL.
5. Solo entonces consulta `docker context show` y
   `docker context inspect default`: acepta exclusivamente
   `default` con `unix:///var/run/docker.sock`, nunca contexto
   remoto ni DOCKER_HOST/DOCKER_CONTEXT/TLS externos.
6. Consulta las imágenes backend/frontend por **ID sha256:config**
   y luego por la etiqueta exacta; repite ambas consultas para
   detectar sustituciones durante la lectura. Compara ID, platform
   linux/amd64, RootFS layers, etiqueta, revision y marca de build
   del backend con el recibo firmado.

Docker **solo** ejecuta `context show`, `context inspect` e
`image inspect`. Nunca `load`, `pull`, `create`, `start`, `run`,
`build`, `compose up`, migraciones ni modificaciones del host.
Si las imágenes todavía no fueron transportadas/cargadas por un
operador autorizado, la inspección falla en lugar de descargarlas
automáticamente.

## Resultado y limitaciones

El resultado positivo es
`HOST_SIGNED_OCI_IMAGES_PRESENT_READONLY_NOT_DEPLOYED`, con hashes
de recibos e IDs verificados; banderas de despliegue, firma humana,
time-of-use y staging permanecen **false**.

**No es GO**, tampoco demuestra la identidad de una imagen en el
instante futuro de `docker compose create/up`. Solo protege esta
lectura contra sustituciones obvias de etiquetas. No evita cambios
posteriores ni protege varias máquinas. No reemplaza el enrolamiento
real de Security Owner y aceptación firmada, el lock operacional
0P.38, los backups externos, staging HTTPS, pruebas offline físicas
ni las cuatro aprobaciones del release #130.

Las pruebas adversariales de este bloque usan claves/reports
**sintéticos exclusivamente inyectados en tests**. La CLI real
siempre invoca los verificadores criptográficos existentes; no existe
modo `--skip-signature` ni modo simulación en producción.

Ningún host remoto, VPS, DNS, secreto, imagen local productiva,
contenedor real o base privada fue accedido durante el desarrollo.
