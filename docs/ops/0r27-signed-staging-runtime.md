# 0R.27 — Aceptación de identidades de contenedores staging usando OCI firmados

**10/11/2026 · Coordinación #18 · Release #130 sigue NO-GO.**

## Falla funcional corregida

Desde el bloque 0R.25 el overlay `docker-compose.staging-oci-override.yml` permite resolver el backend y frontend de staging por los IDs Docker `sha256:<config-id>` de las imágenes provenientes del TAR firmado, y elimina `build` y `pull`. Pero `scripts/verify-staging-runtime.mjs` aún exigía `sedeagro-staging-{backend|frontend}:<SHA>` en `Config.Image`. Por lo tanto, después de una instalación OCI válida, el inspector antiguo habría declarado los contenedores inválidos.

El inspector de contenedores mantiene **sin cambios** su modo anterior de tags locales, para evitar una regresión en staging de desarrollo. Se agrega un modo opcional de comparación por los **dos IDs distintos** de imágenes inmutables, donde exige que tanto `Config.Image` (referencia solicitada al crear el contenedor) como `Image` (ID del binario realmente ejecutado) coincidan exactamente con el ID esperado para backend o frontend. No se admiten tags, imágenes mezcladas, IDs idénticos para ambos servicios, ni contenedores con identidad incompleta. Para evitar mezcla entre lecturas, la opción requiere que el ID del objeto de Docker inspeccionado corresponda al ID encontrado por los filtros del proyecto.

Siguen siendo obligatorios cuatro servicios `db/redis/backend/frontend`, proyecto `sedeagro-staging`, red `sedeagro-staging_staging_internal`, healthchecks sanos, volúmenes staging exclusivos, ausencia de privilegios y acceso host únicamente por `127.0.0.1:4183`. Para la API se comprueban SHA, `NODE_ENV`, modo de seeds, CORS/base domain HTTPS, credenciales de rol de runtime staging y ausencia de `LOG_SQL/LOG_STACK`. El modo puro **no certifica firmas por sí mismo**.

## Revisión real de host, antes de operar

Se incorpora `scripts/review-signed-staging-runtime.mjs`, **exclusivamente de solo lectura**. Exige, en orden:

1. Checkout Linux limpio sobre `main=origin/main=<SHA40>`, hostname de staging admisible, rechazo de Docker y Compose remotos/alternativos y activación explícita `SEDEAGRO_SIGNED_STAGING_REVIEW=REVIEW:<SHA40>`.
2. Autorización humana Ed25519 **real de riesgo de imágenes únicamente** obtenida desde la raíz de confianza versionada del repositorio (sin inyectar claves desde CLI). Sólo se avanza si antes se validan Sigstore/OIDC de GitHub, los dos sujetos OCI y cinco Syft/Trivy y sus hashes/recibos.
3. Inspección del Docker local, dos veces, verificando que los IDs `sha256:` y capas RootFS del backend/frontend coincidan con el TAR/recibo firmado y las imágenes existentes. El daemon debe usar `default` y el socket Unix local.
4. Dos inspecciones completas del proyecto real `sedeagro-staging`, verificando que las cuatro identidades de contenedor **no cambiaron** entre rondas y que las imágenes backend/frontend son exactamente las firmadas. Se detectan reemplazos concurrentes evidentes.

La salida registra únicamente SHA, hostname de staging, digest del TAR/recibos, IDs de imágenes y banderas de aceptación técnica. No imprime `Config.Env`, JWT, password, URL de BD, texto bruto del daemon ni evidencia privada. Los archivos de firma permanecen en un directorio fuera del checkout y con permisos privados.

Ejemplo para usar **únicamente cuando exista una firma humana válida y un staging separado autorizado**:

```bash
SEDEAGRO_SIGNED_STAGING_REVIEW="REVIEW:<SHA40>" \
  node scripts/review-signed-staging-runtime.mjs \
    --sha "<SHA40>" \
    --host "staging.empresa.example" \
    --evidence-dir "/ruta/privada/de/evidencias"
```

Esto **no ejecuta** `docker image load`, `docker compose up`, `docker run/exec`, migraciones, backup/restore ni ajustes de proxy. **No importa imágenes, no inicia ni recrea contenedores.** El operador debe preparar el entorno por un procedimiento independiente y autorizado; el inspector sólo informa el estado existente.

## Evidencia de regresión y riesgo restante

`node --test scripts/test/staging-runtime.test.mjs scripts/test/review-signed-staging-runtime.test.mjs` verifica preservación del modo legacy, identidad por ID de contenedor, anti-downgrade a tags, detección de cambios en origen/imágenes/red/volúmenes/sesiones y orden *firma humana antes que Docker*. El workflow principal ejecuta estas pruebas sobre el SHA exacto, sin fake signing keys en producción. Las funciones inyectables son únicamente para simular errores en los tests; el entrypoint real no acepta claves ni imágenes elegidas por el operador.

**El registro de claves autorizado todavía está vacío.** Ninguna CI exitosa constituye aprobación humana. Todavía faltan staging HTTPS real, migración y restore/rollback externo, p95 real, aceptación de 22 MOB físicos Android/iOS, seis actores y firmas de Producto, Seguridad, Operaciones y Datos. Este bloque **no certifica el momento futuro de creación de contenedores ni producción**; `deploy-prod.sh` sigue reconstruyendo imágenes y el gate de admisión lo bloquea. Issue #130 sigue **NO-GO**.
