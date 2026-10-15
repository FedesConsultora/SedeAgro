# 0T.3 — Staging y release candidata: gates sin despliegue

Fecha de implementación: 15/10/2026. Fuente de verdad: `main` remoto,
workflow `.github/workflows/postgres-isolation.yml` y el artefacto
`sedeagro-staging-<SHA>` de un **push a main con CI exitoso**.
Este documento define un proceso operativo; **no declara staging instalado**.

## Riesgo eliminado en código

El manifiesto `staging-release-manifest.json` ya incluía SHA-256 de
`frontend/dist` y commit de origen, pero `verify-pilot-staging.sh`
comprobaba cabeceras, respuesta HTTP y el SHA **del checkout local**.
No comparaba el HTML, CSS, JavaScript o service worker que realmente
sirve el destino: un proxy podría seguir publicando una mezcla de builds
y mostrar `/health=200` igualmente.

`scripts/verify-deployed-staging.mjs` **solo hace GET de archivos públicos**.
Exige manifiesto válido con HEAD completo exacto, rutas sin traversal,
duplicados ni rutas sospechosas, digests SHA-256, tamaño exacto, límite
total y por archivo y un `index.html` con referencias a assets
manifiestados. Compara `/index.html`, `/sw.js`, todos los archivos
publicados del manifiesto y el HTML servido por `/`. Rechaza
redirecciones, respuestas no-200, bundle alterado y políticas de caché
inseguras para shell/service worker y assets versionados.

Solo permite orígenes HTTPS de staging; `http://127.0.0.1` requiere
`--ci-loopback` **y** `SEDEAGRO_CI_LOOPBACK=1` exclusivamente para
Nginx efímero del job. No abre cookies, no agrega credenciales y no
consulta endpoints privados. No compara imágenes del backend ni su
digest: es **identidad del frontend servido**, no certificación del
stack completo.

## Procedimiento manual en entorno aislado

1. **Congelar la release:** anotar SHA40, URL GitHub Actions run de
   **push** a `main`, dos jobs verdes sobre el mismo SHA y artefacto
   de ese run. Bloquear mezclas entre artefactos de PR, HEAD anterior,
   ramas paralelas o archivos reconstruidos en VPS.
2. **Inventariar y aislar staging:** dominio HTTPS dedicado, red Docker,
   PostgreSQL/PostGIS de staging propia, Redis propia, secretos distintos,
   almacenamiento de evidencia y permisos de archivo. `docker-compose.yml`
   usa nombre de proyecto `sedeagro`, contenedores de producción y
   `fedes-net` externo: **no** se lo debe ejecutar inadvertidamente
   como staging. `scripts/deploy-prod.sh` hace `git pull`, migraciones
   y cambios de servicios, y **no** forma parte de este bloque.
3. **Backup antes de migrar:** DBA autorizado crea `pg_dump -Fc`
   consistente de staging, sin contraseñas en CLI, con archivo
   restringido y cifrado fuera de VPS. Comprueba
   `pg_restore --list`, SHA-256 y retención; prueba una restauración
   completa en base **disposable separada**, con PostGIS y roles
   restaurados/provisionados. Registrar duración, integridad y
   `restore_result=PASS` solo tras ejecutar el ejercicio. La mera
   existencia del dump **no basta**.
4. **Migraciones/control del servicio:** aplicar cambios autorizados
   solo bajo ventana de mantenimiento. Rol propietario únicamente
   para migraciones; API con rol runtime de mínimo privilegio.
   Registrar nombre y estado de `sequelize_migrations`, `NODE_ENV`,
   ausencia de seeds demo, comprobación PostgreSQL RLS entre dos tenants
   y prohibición de puertos DB/Redis publicados.
5. **Backend:** registrar SHA/DIGEST **efectivamente ejecutado** de
   la imagen API, concordante con código probado, versiones
   Node/PostGIS, salud, errores, retención de logs, cookies seguras y
   pruebas sin autenticación. El gate de hashes SPA no cubre este punto.
6. **Frontend:** descargar el manifiesto y el `dist/` **del mismo CI
   de main**. Tras instalar únicamente el artefacto aprobado:
   ```bash
   node scripts/verify-deployed-staging.mjs \
     --url https://staging.example.com \
     --sha SHA40_EXACTO \
     --manifest staging-release-manifest.json
   bash scripts/verify-pilot-staging.sh https://staging.example.com SHA40_EXACTO
   ```
   El primer comando coteja bytes **del servidor remoto**; el
   segundo valida TLS/cabeceras/salud/401, **y** verifica solamente
   el checkout local. Ambos deben pasar. Usar `SHA40_EXACTO`
   como marcador: no copiarlo literalmente.
7. **Prueba de aceptación:** para cada perfil (administrador,
   coordinador, monitoreador, productor y contratista), verificar
   RLS/membresías, alta de establecimiento, campaña, lote,
   recorrida, fotografía y orden, revocación/cambio de sesión,
   error HTTP/recuperación, recibo de sincronización idempotente,
   separación de observación y fotografía. En iPhone Safari y
   Android Chrome físicos, completar MOB-01..12, SEC-01/02,
   OPS-01/02 con casos PASS/FAIL/BLOCKED/NOT_RUN, sin datos reales
   en GitHub.
8. **Rollback aprobado previamente:** conservar digest de frontend y
   backend anteriores, compatibilidad de esquema hacia atrás,
   captura de escrituras posteriores al backup y cola offline
   de dispositivos que no pudieron sincronizar. Una restauración
   de snapshot que pierde registros posteriores no es rollback
   aceptable sin decisión explícita, reconciliación y notificación.

## Formato de evidencia operativa (inicialmente NOT_RUN)

| Gate | Evidencia obligatoria | Estado inicial |
| --- | --- | --- |
| HEAD de main y CI push | SHA40 y run/artefacto exactos | NOT_RUN |
| SPA remota byte a byte | Output del verificador sobre URL HTTPS, SHA40, nombres contados | NOT_RUN |
| HTTPS, headers, health, acceso anónimo | Output del verificador read-only | NOT_RUN |
| Backend imagen exacta | Digest/SHA de contenedor en ejecución | NOT_RUN |
| Migraciones y roles RLS | Versión de esquema y pruebas de aislamiento | NOT_RUN |
| Backup y restore | Checksums, base disposable, log de restore verificado | NOT_RUN |
| Recorrido de producto | Casos y resultados por rol | NOT_RUN |
| iPhone/Android/red rural | Dispositivo, navegador, captura anonimizada y resultado | NOT_RUN |
| Rollback ensayado | Procedimiento y compatibilidad DB/servicio | NOT_RUN |
| Aprobación responsable | Responsable, fecha, release, riesgos abiertos | NOT_RUN |

## Go / no-go

**NO-GO** si alguno de los gates de aislamiento, privacidad, datos
confirmados, backup/restore, conexión segura, release identity, acceso
por rol, sincronización o hardware físico bloqueante permanece FAIL,
BLOCKED o NOT_RUN. El aprobador debe registrar qué módulos y usuarios
fueron probados, incidentes restantes y plan de monitoreo/rollback.
El CI verde autoriza preparar una candidata, **no** producción.

## Comprobaciones automatizadas de 0T.3

- `node --test scripts/test/staging-remote-provenance.test.mjs`
  prueba HTTPS, input inválido, duplicados y traversal, bundle JS
  distinto, service worker distinto, falta de archivo, redirección,
  root HTML viejo y caché incorrecta con servidor HTTP desechable.
- Job `browser-offline`: levanta Nginx real sobre loopback,
  revisa CSP y headers, crea el manifiesto del SHA de checkout,
  verifica manifiesto local, y re-descarga cada byte servido para
  confirmar misma release. No hay VPS ni DB real involucrados.
- Job `tenant-rls`: ejecuta esas pruebas unitarias y conserva
  PostgreSQL disposable, backend, cookies y regresiones históricas.

La ejecución del gate es la única prueba de automatización; nunca
interpretar estas instrucciones como evidencias de staging completadas.
