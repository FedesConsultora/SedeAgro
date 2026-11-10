# 0R.21 — Ejecutar realmente los binarios de imágenes OCI firmadas (CI aislada)

**Fecha:** 10/11/2026 · Coordinación #18 · Release #130 **NO-GO**.

## Problema anterior

Las gates independientes de producción comprueban la firma OIDC Sigstore, inventario Syft/Trivy, archivo TAR OCI, hash y recibo, capa RootFS, SHA, imágenes en el daemon Docker receptor, Compose productivo por IDs sha256 y creación de contenedores **detenidos**. Sin embargo, no ejecutaban el proceso real de las imágenes recibidas; la comprobación de arranque del productor usaba tags antes de transferir el TAR.

## Nueva evidencia funcional

`scripts/ci-oci-running-image-smoke.mjs` corre **al final** del segundo runner de GitHub Actions `offline-image-import`, solamente tras verificar las firmas y las imágenes importadas, y reiterar la paridad del Compose por ID inmutable. Antes de ejecutar Docker vuelve a comprobar el recibo y los dos IDs `sha256:...`.

Se ejecutan dos contenedores temporales que usan exclusivamente los **IDs de configuración firmados** y jamás `sedeagro-*-rc:<SHA>`, con `--pull=never`, `--network=none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, límites de procesos/CPU/RAM y `--rm`. No hay puertos, volúmenes ni env files del host. Los valores de la sesión son datos sintéticos fijos. No se proporciona ningún destino de base real.

1. **Backend Node 22/Express real**: importa `src/app.js`, inicia Express en `127.0.0.1` **dentro** del namespace aislado, verifica `GET /health` responde 200 con servicio correcto, `GET /health/revision` responde el SHA40 incorporado en la imagen y `GET /health/ready` responde **503** con `ready:false` frente a la base deliberadamente ausente. No se simula el servidor ni se habilita acceso hacia afuera; prueba la semántica fail-closed.
2. **Frontend Nginx real**: comprueba que `index.html` y `sw.js` existen, que no haya `.env` ni `node_modules` en la raíz estática y ejecuta `nginx -t` con nombre interno de upstream resuelto localmente. Las rutas de PID/cache reciben tmpfs efímero.

Cada contenedor recibe un nombre aleatorio, se verifica que `--rm` lo eliminó y, ante cualquier resto, se intenta limpieza forzada **únicamente de ese nombre CI** y se rechaza el resultado. El script retorna `CI_OCI_NETWORKLESS_RUNTIME_SMOKE_SUCCESS_NOT_DEPLOYED`, con los IDs exactos ejecutados y advertencias `production_go:false`, `staging_certified:false` y `production_cutover_tested:false`. Si la firma, SHA, identidad, prueba de salud o limpieza falla, la gate devuelve error genérico sin stderr de Docker ni secretos.

## Límites y pruebas

Las pruebas `node --test scripts/test/ci-oci-running-image-smoke.test.mjs` inyectan **un ejecutor Docker simulado**, sólo para los casos negativos; los tests de la CI principal ejecutan además el comando **real** sobre las imágenes firmadas en el daemon del runner receptor. Se prueban recibos mutados, IDs incorrectos, tags mutables, entorno indebido, DB/puertos/volúmenes, uso no autorizado de CI, error del proceso y cleanup incompleto.

La prueba **no certifica** la conexión a PostGIS, Redis, permisos de base en producción, interacción real de usuario, cero downtime, HTTPS, staging ni la creación productiva de contenedores. Es un paso intermedio sobre los **mismos bytes** del artefacto firmado.

El proceso de despliegue productivo sigue **intencionalmente bloqueado** porque `deploy-prod.sh` reconstruye imágenes locales y faltan las firmas humanas de Seguridad/Operaciones, un corte inmutable autorizado, backup externo restaurado y rollback ensayado, pruebas físicas Android/iOS y aceptación del piloto. Ningún VPS fue modificado.
