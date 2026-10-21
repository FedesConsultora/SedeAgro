# 0P.29 — SBOM y análisis de vulnerabilidades de imágenes reales

## Riesgo que corrige

Los bloques 0P.24–0P.28 demuestran paridad byte a byte del frontend, empaquetado Docker, importación independiente, procedencia GitHub/Sigstore y referencias inmutables de las imágenes base. Pero **ni el digest SHA256 ni una attestation prueban que los paquetes instalados sean seguros**. Una imagen puede estar perfectamente identificada y seguir conteniendo CVEs o paquetes obsoletos.

0P.29 genera un inventario de software (SBOM SPDX 2.3) y un análisis de vulnerabilidades para **cada imagen backend/frontend de producción ya construida para el SHA del PR o de main**. Ningún resultado escanea solo el árbol Git o el lockfile: analiza el contenido de ambos contenedores finales.

## Herramientas, procedencia y supuestos

- **Syft v1.55.0**, acción `anchore/sbom-action` fijada al commit `e22c389904149dbc22b58101806040fa8d37a610`: produce `spdx-json` de la imagen Docker local de backend y frontend. La acción no envía snapshots de dependencias a la API de GitHub, no publica releases y no sube un artifact por sí sola.
- **Trivy v0.76.1**, acción `aquasecurity/trivy-action` fijada al commit `ed142fd0673e97e23eac54620cfb913e5ce36c25`: `scan-type:image`, `scanners:vuln`, tipos OS y librerías, severidades completas UNKNOWN/LOW/MEDIUM/HIGH/CRITICAL, `ignore-unfixed=false` y `cache=false`. Se exporta JSON; el exit code del scanner es `0` para **permitir analizar exhaustivamente el JSON sin perder la evidencia**. Un fallo de ejecución de la acción, un reporte inexistente o malformado **sí bloquea el CI**.
- Las imágenes son `sedeagro-backend-rc:<SHA40>` y `sedeagro-frontend-rc:<SHA40>`; cada una exige OCI label Git, Linux amd64 e ID de configuración `sha256` exacto. **No usa registry ni publica imágenes nuevas.**

Los paquetes e identificadores de vulnerabilidades pueden cambiar cuando cambian los datos de Trivy; la versión fija el motor, **no la base de CVEs**, cuya actualidad no puede darse por certificada sin controles adicionales. Los resultados no significan ausencia de riesgos o de vulnerabilidades no detectadas.

## Artefactos por SHA exacto

Los cuatro archivos principales:

| Archivo | Contenido |
| --- | --- |
| `sedeagro-backend-<SHA>.spdx.json` | Inventario Syft de dependencias efectivamente presentes en backend |
| `sedeagro-frontend-<SHA>.spdx.json` | Inventario Syft de la imagen final Nginx/frontend |
| `sedeagro-backend-<SHA>.trivy.json` | Vulnerabilidades OS/librerías en imagen backend |
| `sedeagro-frontend-<SHA>.trivy.json` | Vulnerabilidades OS/librerías en imagen frontend |

Se produce un quinto archivo `sedeagro-security-<SHA>.json` que liga los cuatro SHA256 de informes con el SHA Git exacto y los **config IDs Docker** de ambas imágenes, contiene recuentos por severidad, disponibilidad de `FixedVersion`, decisión de release y limitaciones de certificación. No sustituye el informe bruto ni inventa un inventario reducido.

`scripts/verify-image-security.mjs` define tres operaciones:

1. `--mode create`, en `production-images`: lee cada SPDX y reporte Trivy, comprueba esquema, herramienta, paquetes únicos, referencia exacta de cada imagen, cobertura, hallazgos completos, y compara con `docker image inspect`. Crea el recibo en el directorio privado `RUNNER_TEMP` usando permisos `0600`, sin sobrescribir datos existentes.
2. `--mode verify`, tanto en productor como firmante: vuelve a calcular los cuatro hashes y toda la evaluación de riesgos, y comprueba **igualdad exacta de contenido** con el quinto archivo. Requiere que los config IDs del recibo correspondan a las dos imágenes en el recibo OCI del TAR original. Un reporte alterado, mezclado con otro SHA o truncado falla antes de firmar.
3. `--mode verify-signed`, en `offline-image-import` solo en el `push/main` definitivo: primero repite esas comprobaciones y luego pide a GitHub CLI verificar las **cinco attestations de sujetos firmados** con las restricciones del 0P.27: repo, workflow, ref `refs/heads/main`, SHA completo, SLSA v1, certificado Sigstore verificado y rechazo de runners self-hosted. Los nombres y hashes firmados deben coincidir byte a byte. **Solo después** puede ejecutarse `docker image load` del paquete del mismo run.

Los dos archivos TAR+recibo conservan su attestation anterior. Los cinco archivos de seguridad se firman en una **attestation separada** dentro del mismo job `attest-oci-bundle`. Esta separación permite revocar, comparar o sustituir los reportes sin confundir un SBOM con un digest publicado de una imagen en registry.

El productor publica el artifact `sedeagro-security-<SHA>` **solo en `main`**, con retención de siete días; no se publica en PRs. En un repositorio público, esta evidencia puede ser accesible externamente; el contenido de imagen generado en CI está previsto para inspección operativa. Nunca se escanean o suben secretos privados de staging o bases de datos.

## Política de riesgo: CI ≠ autorización de release

El verificador falla con código distinto de cero ante falta de cobertura o procedencia, y conserva todos los hallazgos. **No ignora vulnerabilidades sin parche ni debilita severidades para obtener una corrida verde**.

| Hallazgo del escaneo completo | Evaluación de release |
| --- | --- |
| Algún HIGH o CRITICAL (con o sin versión corregida) | `BLOCKED_HIGH_OR_CRITICAL_SECURITY_FINDINGS` |
| Solo LOW/MEDIUM/UNKNOWN, o ningún hallazgo conocido | `EXTERNAL_SECURITY_REVIEW_REQUIRED` |
| Faltan informes, schema, IDs, subjects firmados o hashes coincidentes | CI `FAIL`: no hay evidencia confiable de revisión |

`release_go` queda **siempre false** dentro de este bloque. Que el job haya analizado correctamente un reporte con HIGH/CRITICAL **no significa** que esos riesgos estén aceptados: prueba que los reconoció y marcó explícitamente la release como BLOQUEADA, y conserva evidencia para priorizar remediaciones.

Para desactivar un bloqueo no se deben eliminar CVEs con `ignore-unfixed`, editar el JSON, rebajar severidad ni cambiar el umbral global. Debe haber una revisión independiente con responsable, impacto, imagen/paquete, CVE, disponibilidad de parche, compensaciones, vencimiento de la excepción y aprobación en el proceso GO/NO-GO #130. **Este bloque no implementa excepciones automáticas ni autoriza desplegar imágenes vulnerables.**

## Procedimiento de actualización y seguimiento

1. Tomar el HEAD exacto de `main` y la ejecución `push` donde los seis jobs estén `completed/success`. Buscar los artifacts `sedeagro-oci-<SHA>` y `sedeagro-security-<SHA>`.
2. Verificar sus firmas GitHub/Sigstore desde una estación aprobada, con `gh attestation verify` y los mismos flags de origen/commit; contrastar ambas imágenes OCI y los cinco hashes de reportes. Los scripts CLI de este bloque exigen un runner GitHub exacto: ejecutar directamente la CLI fuera de CI está intencionalmente bloqueado.
3. Ordenar remediaciones: CVEs CRITICAL/HIGH disponibles para parche primero, luego dependencias directas/transitivas o paquetes OS; valorar exposición real y forma de explotación con expertos. Trivy no calcula por sí solo el impacto contextual.
4. Actualizar Node/Nginx/PostGIS/Redis siguiendo **0P.28** (digests verificados, revisados), o los lockfiles de `npm` en un PR diferente con sus pruebas funcionales. **No reconstruir ni retaggear** como si fuera el mismo SHA anterior: cada modificación usa un nuevo commit y su evidencia nueva.
5. Evaluar costos y variación de las bases CVE. Documentar vulnerabilidades sin solución como riesgos residuales con propietario y fecha de revisión. Los resultados en CI pueden evolucionar incluso sin cambios de código debido a actualizaciones de la base de CVEs.

## Pruebas y limites

`scripts/test/image-security.test.mjs` prueba: rechazo de imágenes con etiquetas, IDs o arquitecturas ajenas; inventario SPDX vacío o falsificado; cobertura Trivy incompleta; CVEs duplicados; clasificación de HIGH/CRITICAL con y sin `FixedVersion`; manipulación de archivos, resumen o recibo OCI; symlinks; sujeto Sigstore inválido; negativa fuera de GitHub; secuencia del workflow antes de `docker load`. Se ejecuta dentro de `tenant-rls`.

Premerge: cuatro jobs efectivos `SUCCESS` sobre el último SHA del PR. Posmerge: seis jobs efectivos `SUCCESS` sobre el nuevo SHA, incluyendo ambas attestations y la verificación en runner independiente. Deben comprobarse los logs de reporte y decisión de release, no solamente el semáforo.

**No certifica** cero CVEs, antigüedad máxima de Trivy DB, firmas de los publishers, paridad de builds independientes, registro OCI remoto firmado, backup privado off-VPS, HTTPS/TLS real, RLS en datos operativos, monitoreo ni QA Android/iOS físico. No hay despliegue ni acceso al VPS, DNS, TLS, credenciales o datos privados. Issue **#130 permanece NO-GO**.
