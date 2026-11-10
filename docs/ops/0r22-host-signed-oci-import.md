# 0R.22 — Importar imágenes OCI firmadas al host, sin desplegarlas

**10/11/2026 · Coordinación #18 · Release #130: NO-GO.**

## Brecha que resuelve

La CI ya verifica los bytes y las firmas Sigstore de GitHub, importa en un runner efímero y comprueba el arranque aislado de imágenes por ID. El host operativo puede revisar imágenes **ya presentes** mediante `inspect-host-oci-images.mjs` / `inspect-host-oci-compose.mjs`, pero faltaba una herramienta específica, controlada y auditable para importar al daemon local **el mismo TAR OCI firmado**.

El nuevo `scripts/import-host-signed-oci-images.mjs` admite exclusivamente `--mode check-only` y `--mode import-only`. Ambos requieren SHA40 exacto en checkout limpio `main=origin/main`, evidencia privada fuera del checkout y la revisión real Ed25519 de riesgo humano con clave pública del registro versionado. El registro `scripts/security-owner-trust.json` sigue vacío, de modo que hoy el comando real **debe rechazar la operación**; no existe modo de proveer una clave desde variables de entorno o argumentos CLI.

Antes de conectar con Docker, comprueba los siete sujetos OCI+Syft/Trivy firmados y las firmas de riesgo, la lectura segura de `oci/sedeagro-images-<SHA>.json`, hash del recibo ligado a la firma humana, más el recorrido **por streaming** del TAR `oci/sedeagro-images-<SHA>.tar` mediante el parser existente `verifyReceipt`: estructura, capas, labels, hashes y ambas imágenes exactas.

El daemon debe ser local Linux con `default` en `unix:///var/run/docker.sock`; cualquier `DOCKER_HOST`, `DOCKER_CONTEXT`, config remota de TLS o `COMPOSE_FILE` heredado queda bloqueado. Se deniegan tags preexistentes `sedeagro-*-rc:<SHA>` que apunten a bytes diferentes: **no se sobreescribe ninguna imagen que pueda estar en uso**.

En `check-only` se verifican los tags/IDs existentes y se devuelve una lista de imágenes ausentes, **sin `docker image load`**. En `import-only`, y sólo si falta al menos una imagen, se invoca `docker --context default image load --input <TAR_VERIFICADO>`. Luego inspecciona dos veces los dos IDs de configuración inmutables, tags, SHA OCI, capas RootFS y plataforma linux/amd64 y vuelve a invocar el inspector de siete sujetos firmados sobre ese mismo host. Si falla a mitad de importación se detiene sin intentar borrar otras imágenes o contenedores; Operaciones debe inspeccionar manualmente el daemon.

**No se ejecuta** `docker compose up`, `docker container create/start/run`, `docker pull/build`, migración, backup, restore, reload del proxy ni ningún despliegue. La única modificación permitida en el host es el almacén local de imágenes Docker.

## Uso futuro por un operador autorizado

Con recibos y TAR reales y una firma humana auténtica vigente, desde un Linux autorizado:

```bash
node scripts/import-host-signed-oci-images.mjs \
  --sha "<SHA40>" \
  --evidence-dir "/ruta/privada/canonica" \
  --mode check-only
```

Para importar imágenes únicamente:

```bash
SEDEAGRO_OCI_IMPORT_APPROVAL="IMPORT_ONLY:<SHA40>" \
  node scripts/import-host-signed-oci-images.mjs \
    --sha "<SHA40>" \
    --evidence-dir "/ruta/privada/canonica" \
    --mode import-only
```

El resultado tiene estatus `HOST_SIGNED_OCI_IMAGES_IMPORTED_ONLY_NOT_DEPLOYED`, con IDs y digests exactos, pero `production_go:false`, `security_owner_deploy_approved:false`, `containers_started:false` y `production_cutover_tested:false`.

## Pruebas y aceptación restante

La CI especializada `host-oci-image-import.yml` prueba *sin acceso a un Docker real* el orden firma → TAR offline → contexto Docker → importación, así como tags falsificados, hashes incorrectos, firmas ausentes, carga parcial, contextos remotos y ausencia de permisos. Los dobles de firmas/digests solamente se inyectan en esos tests. La CI principal ya ejerce importación real de OCI firmado en su segundo runner desechable.

Faltan procedimiento y aprobación de Operaciones para cutover de contenedores desde los IDs (con bloqueo de tiempo de creación y rollback), ensayo de ese proceso en staging autorizado, restauración de backup externo, pruebas físicas Android/iOS, ruta de seis actores, benchmarks HTTP y firmas de Producto/Seguridad/Ops/Datos. `deploy-prod.sh` y `verify-production-image-admission.mjs` continúan intactos y deniegan el release. **NO-GO.**
