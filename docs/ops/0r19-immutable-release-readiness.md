# 0R.19 — Candidato de promoción OCI: riesgo humano + configuración inmutable

**Fecha:** 10/11/2026 · Coordinación #18 · Dependencia #302 · Release #130 **NO-GO**.

## Avance real

Hasta ahora existían tres verificadores distintos: `verify-release-owner-approval.mjs` comprueba una aceptación independiente Ed25519 firmada por el Security Owner sobre los riesgos del escaneo (no autoriza desplegar); `inspect-host-oci-compose.mjs` inspecciona imágenes Docker reales en el socket local y el Compose productivo resuelto con IDs `sha256:` (bloque #302); `verify-production-image-admission.mjs` finalmente **deniega** el deploy porque `deploy-prod.sh` todavía reconstruye imágenes.

Esta PR extrae una función read-only `inspectSignedImageCandidate` desde el validador de admisión **sin modificar su bloqueo final**. Comprueba el SHA40, los siete sujetos firmados OIDC de GitHub (dos OCI y cinco reportes de seguridad), inventario sin HIGH/CRITICAL, y la aceptación humana **real** Ed25519 mediante el registro versionado `scripts/security-owner-trust.json`. Su resultado identifica SHA/digest OCI/recibo/reportes y marca inequívocamente `production_go:false`, `other_owners_approved:false` y `containers_created:false`. La función anterior `inspectProductionImageAdmission` continúa invocándola y luego ejecuta incondicionalmente `deny('deploy-prod.sh rebuilds Docker images...')`.

Se agrega un orquestador **de solo lectura**, `scripts/review-production-immutable-candidate.mjs`, que:

1. Exige SHA40 exacto, evidencia privada, `main` limpio igual a `origin/main` y Docker por socket local, sin overrides.
2. Requiere la activación manual `SEDEAGRO_IMMUTABLE_RELEASE_REVIEW=REVIEW:<SHA>`; esto autoriza **revisar**, no desplegar.
3. Verifica **primero** la aceptación humana Ed25519 del riesgo, sin llamar a Docker si falta, caduca o fue revocada.
4. Inspecciona después el par de imágenes OCI ya presente en el Docker local, las capas, firmas y el Compose con configuración por ID inmutable. Se verifica de nuevo tras resolver el plan para detectar cambios concurrentes.
5. Compara exactamente **SHA, digest del TAR firmado, digest del recibo y digest de seguridad** entre la aceptación humana y la inspección local, además de exigir backend/frontend como IDs `sha256:` distintos.
6. Devuelve un informe de revisión de candidato (no GO) que no contiene nombres de usuario, correo, secretos, comandos de despliegue ni datos empresariales.

## Ejecutar cuando haya evidencia humana auténtica (no ahora)

En un Linux autorizado, con imágenes ya importadas de un TAR realmente firmado, registro de confianza revisado y permisos privados de evidencia:

```bash
SEDEAGRO_IMMUTABLE_RELEASE_REVIEW="REVIEW:<SHA40>" \
  node scripts/review-production-immutable-candidate.mjs \
    --sha "<SHA40>" \
    --evidence-dir "/ruta/privada/de/evidencias"
```

El comando no ejecuta `docker load`, `docker compose up`, `build`, `pull`, `run`, `create`, SQL, migraciones, backup/restore ni reload de proxy. Sólo inspecciona configuración e identidad por el Docker socket local. La raíz de confianza real sigue **sin ninguna clave autorizada**, por lo tanto se espera que esta herramienta rechace una ejecución hoy, antes de consultar Docker.

La CI prueba con identidades y firmas **sintéticas inyectadas sólo en tests**, para verificar fallos y contratos sin inscribir claves reales, falsificar aprobaciones o alterar producción. El nuevo workflow también vuelve a ejecutar los tests del verificador Ed25519.

## Condiciones restantes para GO

**Una aceptación de riesgo no es autorización de despliegue.** La salida declara explícitamente `security_owner_deploy_approved:false`, `other_owners_evaluated:false`, `staging_certified:false`, `rollback_certified:false` y `production_go:false`.

Todavía faltan: registro/rotación de claves con revisión humana independiente, importación y promoción operativa del mismo OCI firmado sin rebuild (con prueba en staging y control de tiempo de creación de contenedor), respaldo cifrado off-VPS restaurado y rollback ensayado, benchmark HTTP p95 real, 22 casos MOB físicos Android/iOS, ruta de seis actores y firmas Producto/Seguridad/Ops/Datos. `scripts/deploy-prod.sh` **sigue bloqueado** por su implementación actual. No modificar esa barrera hasta disponer del mecanismo probado y autorizaciones separadas.
