# 0P.27 — Attestations firmadas de GitHub para paquete OCI y recibo

## Riesgo comprobable y alcance

0P.25 autentica **integridad de los bytes del TAR**, imagen/capas y recibo SHA256. 0P.26 demuestra que esos mismos archivos pueden descargarse e importarse realmente en un Docker limpio de GitHub Actions. **Ninguno verificaba quién firmó o produjo esos bytes.** Quien sustituyera TAR y recibo por otro par coherente podía superar una comparación de hashes sin una identidad confiable.

0P.27 añade attestations de procedencia SLSA firmadas mediante la identidad **OIDC de GitHub Actions** y un certificado Sigstore de corta duración. Se generan para **ambos archivos exactos** del release —el TAR y el JSON—. El receptor verifica criptográficamente la firma y la cadena de confianza por medio de `gh attestation verify`, la identidad del repositorio y workflow, la rama y commit exactos, y después exige que cada sujeto firmado tenga el nombre y SHA256 que se acaba de descargar.

La funcionalidad solo está habilitada para un repositorio GitHub **público** en este flujo y únicamente al integrar por `push` a `main`; nunca firma un PR, datos privados, bases, ni una ejecución de staging/VPS.

## Flujo de CI

### 1. `production-images` — conserva permisos de solo lectura

El productor realiza lo ya certificado en 0P.24–0P.26: build, comparaciones frontend, `docker save`, verificación completa del TAR, receipt SHA256, eliminación de tags del runner descartable, reimportación real con config IDs/capas intactos, subida del artifact `sedeagro-oci-<SHA>` por siete días. **No posee `id-token:write` ni `attestations:write`.**

### 2. `attest-oci-bundle` — job independiente que firma únicamente `main`

Depende de `production-images` exitoso. Hace checkout exacto del `github.sha`, descarga del mismo run el TAR y recibo, y **repite la verificación del paquete y sus capas** mediante el verificador offline existente. En caso de error no obtiene una firma favorable. Posteriormente usa `actions/attest@v4` sobre:

- `sedeagro-images-<SHA>.tar`
- `sedeagro-images-<SHA>.json`

Concede exclusivamente a **este job** `contents:read`, `id-token:write`, `attestations:write`, `artifact-metadata:write`. GitHub/Sigstore emite una attestation SLSA in-toto y la guarda en el servicio de attestations del repositorio. No crea claves privadas persistentes, no usa secrets de firma ni registra credenciales en logs. No hay registry, release tag ni `docker push`.

### 3. `offline-image-import` — verificación de firma y bytes previa a la importación

El receptor en un **tercer job/runner** depende de `production-images` y `attest-oci-bundle`; no puede importar mientras la firma esté pendiente o fallida. Descarga el par de archivos del mismo run y usa:

1. `scripts/oci-release-bundle.mjs verify`: TAR completo, SHA256, config IDs y capas.
2. `scripts/verify-oci-signed-provenance.mjs`: invoca `gh attestation verify` para cada archivo, con restricciones inamovibles:
   - `--repo FedesConsultora/SedeAgro`
   - `--signer-workflow FedesConsultora/SedeAgro/.github/workflows/postgres-isolation.yml`
   - `--source-ref refs/heads/main`
   - `--source-digest <SHA completo esperado>`
   - `--predicate-type https://slsa.dev/provenance/v1`
   - `--deny-self-hosted-runners`
   - `--format json`
3. Exige que la salida de `gh` sea no vacía y contenga al menos una statement SLSA verificada vinculada al **nombre exacto** y **hash SHA256 real** del archivo, con certificado y sello de tiempo comprobados. Una attestation de otro repo, workflow, branch, commit, otro TAR o receipt modificado **bloquea** la aceptación.
4. Solo después se ejecuta `scripts/ci-oci-import-rehearsal.mjs --mode fresh`: importación real de ambas imágenes al Docker limpio con comparación de tags, config IDs y rootfs layers.

El usuario recibe un resultado `GITHUB_SIGNED_OCI_ARTIFACTS_VERIFIED_NOT_DEPLOYED` y el habitual `CI_OCI_IMPORT_REHEARSAL_VERIFIED_NOT_DEPLOYED`. El primero evidencia **firma del actor CI**; el segundo evidencia **portabilidad de las imágenes**. Las attestations se verifican frente a los certificados/Sigstore y la API pública de GitHub; **este último paso no es completamente offline**, aunque la verificación de integridad y la importación Docker sí lo son.

## Reproducir verificación firmada como operador

Obtener los archivos únicamente desde el artifact de GitHub Actions del `push/main` cuyo workflow/HEAD exacto se verificaron. Ejecutar en una estación aprobada con GitHub CLI actualizado:

```bash
# Primer gate: recibo y TODOS los bytes del TAR; no ejecuta Docker.
node scripts/oci-release-bundle.mjs verify \
  --sha "SHA_GIT_COMPLETO_CONFIRMADO" \
  --bundle "/ruta-privada/sedeagro-images-SHA_GIT_COMPLETO_CONFIRMADO.tar" \
  --receipt "/ruta-privada/sedeagro-images-SHA_GIT_COMPLETO_CONFIRMADO.json"

# Segundo gate: para CADA archivo, verificar firma e identidad del actor;
# esta operación requiere HTTPS a servicios públicos GitHub/Sigstore.
gh attestation verify "/ruta-privada/sedeagro-images-SHA_GIT_COMPLETO_CONFIRMADO.tar" \
  --repo FedesConsultora/SedeAgro \
  --signer-workflow FedesConsultora/SedeAgro/.github/workflows/postgres-isolation.yml \
  --source-ref refs/heads/main \
  --source-digest "SHA_GIT_COMPLETO_CONFIRMADO" \
  --predicate-type https://slsa.dev/provenance/v1 \
  --deny-self-hosted-runners --format json

# Repetir para .json y cotejar el digest y el nombre en los subjects.
```

Para replicar exactamente el gate de CI usar `scripts/verify-oci-signed-provenance.mjs` en el runner autorizado; la CLI intencionalmente **niega ejecuciones fuera de GitHub Actions** y su equivalente de operator-review requiere validación explícita de los dos comandos `gh` y hashes.

Consultar docs oficiales: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations y https://cli.github.com/manual/gh_attestation_verify.

## Pruebas de regresión

`scripts/test/verify-oci-signed-provenance.test.mjs` cubre la identidad exacta de los argumentos `gh`, firma de dos archivos, bloqueo ante hash cambiado, fallo del preflight anterior a cualquier consulta de red, retorno no firmado/attestation vacía, modificación del JSON, cambio de nombre, ausencia del certificado/sello temporal, error criptográfico de `gh`, input symlink, ejecución fuera de main y guardas estáticas de permisos/pasos del workflow.

**Aceptar un exit=0 de `gh` no basta**: se inspeccionan subjects con nombres/hashes exactos. Tampoco basta un JSON de subjects generado localmente: `gh` debe verificar antes la firma y la identidad OIDC.

## Límites que no deben confundirse

- Esto autentica que un **workflow identificado de GitHub Actions** generó la attestation para los bytes específicos y el commit de origen indicado. No demuestra independencia del código del builder: alguien capaz de modificar el workflow autorizado, controlar el runner o manipular el contexto de construcción podría firmar bytes maliciosos con esa misma identidad. Requiere protección de ramas, revisión externa y políticas de permisos.
- Se firman los **archivos TAR + recibo**, no un digest OCI de contenedor publicado en GitHub Container Registry, Docker Hub ni otro registry. No hay `repo@sha256` firmado ni publicación de imágenes.
- No certifica ningún backup privado off-VPS, datos restaurados, roles/RLS de staging real, TLS/HSTS/DNS, monitoreo, rollback operativo, dispositivos Android/iOS físicos ni aceptaciones de responsables.
- El Artifact TAR/JSON mantiene retención **7 días**. La attestation pública puede persistir después, pero no sustituye a la conservación controlada de los bytes. Que la firma siga verificándose no garantiza que el archivo descargable todavía exista.

## Contrato de cierre

PREMERGE: 4/4 checks efectivos `completed/success` sobre el HEAD exacto; `attest-oci-bundle` y `offline-image-import` deben aparecer `skipped` en PR y no son certificaciones premerge. Merge normal, conservar commits atómicos. POSMERGE: **6/6 checks** en `completed/success` sobre nuevo `main`: los cuatro anteriores, `attest-oci-bundle` y `offline-image-import`. Comprobar que el receptor ejecutó `gh attestation verify` para ambos sujetos antes de `docker image load`. Registrar enlace de ejecución, ID/hashes del TAR y attestations, liberar claim en #18 y mantener release #130 **NO-GO**.
