# 0P.33 — Hard-stop de promoción productiva con evidencia firmada

## Defecto corregido

Antes, `scripts/deploy-prod.sh` invocaba `production-preflight.sh` después
de `git pull`, pero el control de seguridad solo validaba el lockfile npm y su
política baseline. Con `DEPLOY:<SHA>` y configuración válida podía llegar a
`docker compose build` sin comprobar las cinco evidencias Syft/Trivy, sus
firmas o `release_go`. Esas cinco evidencias reales tienen
`release_go=false` incluso si el escaneo marca 0 HIGH y 0 CRITICAL.
Además, el despliegue reconstruye imágenes **en el host** y no importa el
Docker-save TAR cuyos bytes y firmas verificó el CI.

## Lo implementado

**Cero cambios de infraestructura y cero despliegues.** El preflight ahora:
1. Continúa verificando SHA40 literal, branch/main y origin/main idénticos,
   checkout limpio, configuración privada y baseline npm sin excepciones.
2. Antes de ejecutar Docker/migraciones, exige
   `SEDEAGRO_SIGNED_RELEASE_DIR` y falla si no existe. Esa variable **no
   autoriza el despliegue**.
3. El inspector solo admite una carpeta canónica, privada (0700), fuera del
   checkout, con subdirectorios `security/` y `oci/` también privados.
4. Valida `security/` con el verificador existente de cinco firmas
   GitHub/Sigstore/SLSA del workflow
   `FedesConsultora/SedeAgro/.github/workflows/postgres-isolation.yml`,
   `refs/heads/main` y SHA de origen exacto; inspecciona dos SBOM SPDX,
   dos Trivy y resumen, hashes/cobertura completa y vínculo con el
   `oci/sedeagro-images-<SHA>.json`.
5. **Niega** `release_go=false`, `security_owner_review_required=true`,
   falta de decisión `APPROVED_FOR_RELEASE`, inventario inválido o
   HIGH/CRITICAL presentes. La combinación actual es
   `release_go=false` y `EXTERNAL_SECURITY_REVIEW_REQUIRED` → NO-GO.
   Un `DEPLOY:<SHA>` jamás es sustituto de esa aprobación.
6. En un futuro, SI se produjera una decisión de seguridad positiva
   verificable, el inspector exigiría además el TAR completo
   `oci/sedeagro-images-<SHA>.tar`: checksum total, configs/capas e
   identidad de ambos servicios y firmas GH del TAR + receipt.
7. **Hard-stop adicional permanente para este deploy**: tras esas
   verificaciones rechaza igualmente la promoción porque
   `deploy-prod.sh` usa `docker compose build backend frontend`;
   una imagen reconstruida no es automáticamente el TAR firmado. Una
   modificación independiente y revisada tendrá que implementar consumo
   del bundle firmado, comparación de IDs y permisos, y recién entonces
   sustituir este bloqueo explícito.

La existencia del directorio **no permite ninguna ejecución de Docker** en
el preflight. El script es read-only, salvo las lecturas de `gh attestation`
contra GitHub en el hipotético flujo con evidencia válida. Si no hay GH CLI,
archivos, firma o conectividad, rechaza. Los mensajes públicos de error no
muestran contenidos de secretos, rutas privadas, detalles de credenciales
ni respuestas JSON completas de certificados.

## Riesgo residual y criterio de aceptación

- `npm audit` de lockfile y Syft/Trivy de imagen son controles distintos.
- GH OIDC attestation prueba procedencia del workflow/commit/archivo;
  **no prueba** una firma de Security Owner, QA físico ni autorización de VPS.
- La revisión humana del único MEDIUM y de dos UNKNOWN del backend todavía
  requiere firma/decisión trazable. No cambiar `review.release_go` editando
  un JSON: la comparación exacta de los archivos fuente y sus firmas lo
  rechazará.
- Tests negativos sobre umbrales, ausencia/mutación de firma, SHA, directorios,
  inmutabilidad y no bypass; gates 4/4 PR HEAD y 6/6 push/main, ambas
  ejecuciones independientes. El estado exitoso del pipeline **no da GO**.

## Qué falta para ejecutar el primer piloto

**No ejecutar `scripts/deploy-prod.sh` con la infraestructura actual.**
Una entrega futura necesita diseño operacional de importar imagen OCI
verificada en un entorno aislado, comprobación antes de la migración de
`sha256:config` y RootFS de cada imagen que Compose realmente usará,
Security Owner firmado, staging/TLS y prueba de rollback+restore fuera
de la VPS. Después, aceptación por roles y pruebas físicas Android/iOS
con modo offline rural. Mantener #130 NO-GO hasta esas firmas.

No se usaron VPS, DNS, certificados, claves, DB privadas, secretos ni
servicios reales en este bloque.
