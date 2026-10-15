# 0S.13 — Integridad SHA-256 de evidencias (verificación manual, acotada y privada)

## Nuevo flujo

Desde **Monitoreo → detalle autorizado → Verificación de fotografías y archivos**, el usuario puede seleccionar **Verificar SHA-256** sobre **un archivo visible**. La pantalla del bloque 0S.12 continúa mostrando, por separado, si existe un registro privado de bytes. No se inicia una verificación automáticamente al abrir el panel, al reconectar ni al mostrar una nueva lista.

**Endpoint:** `GET /api/v1/scouting/evidence/:id/integrity`. Exige:
- cookie/JWT y pertenencia activa a empresa, entitlement `scouting`, capability `scouting.read`;
- `EvidenceAsset` y `ScoutingObservation` del tenant bajo PostgreSQL FORCE RLS;
- `findRun(req, observation.scouting_run_id)` para comprobar que un monitoreador conserve la asignación a esa recorrida (si no, 404).
- `Cache-Control: private, no-store`; respuesta exclusivamente `{ data: { id, status } }`. No envía el SHA-256 esperado ni calculado, bytes, nombre de archivo, geolocalización ni información de otros usuarios.

## Comprobación real, no inferida

1. El servidor busca la evidencia y comprueba permisos sobre la recorrida.
2. Consulta `octet_length(content)` en `evidence_blobs` por tenant+evidencia, **sin traer bytes a Node**. Si no hay blob, resultado `missing`.
3. Si el blob supera **2 MiB** (límite de upload del MVP), resultado `oversize`, sin leer bytes. Hash ausente/malformado o tamaño declarado inválido: `unverifiable`. Metadatos con tamaño distinto al bytea: `mismatch`.
4. Sólo si existen SHA-256 de 64 caracteres hexadecimales y tamaño válido coincidente, lee el contenido bajo **un nuevo predicado SQL `octet_length(content) <= MAX_EVIDENCE_BYTES`**; la segunda consulta impide que un cambio entre lectura de tamaño y selección cargue un blob mayor de 2 MiB. Calcula SHA-256 de los bytes reales en el backend y compara con `timingSafeEqual`.
5. Devuelve uno de cinco estados: `verified` (coinciden SHA-256 + tamaño), `mismatch` (corrupción, hash/tamaño alterado), `missing` (sin blob), `unverifiable` (legacy sin hash, metadatos inválidos o lectura inconsistente), `oversize` (contenido fuera del límite). Ningún estado se guarda como una marca de verificación permanente; una nueva consulta puede cambiar su resultado.

El resultado `verified` indica integridad **respecto al hash almacenado**, no autenticidad criptográfica del origen, examen antivirus ni garantía de disponibilidad futura. Tampoco es prueba de que la foto local pueda eliminarse: la confirmación/corrección de cargas y la política CAS/idempotencia continúan exclusivamente en Sincronizaciones.

## Experiencia y límites

- La lista de evidencias sigue limitada a los **100 registros recientes** y solo expone acciones para los **10 ya visibles**. No hay un escaneo masivo, scheduler, trabajos de fondo ni consumo de disco adicional.
- El panel solo muestra las evidencias permitidas de la recorrida cargada con éxito; la respuesta de un archivo no autorizado no se usa ni se almacena. La comprobación invalida los resultados al perder conexión, actualizar el listado, cerrar/cambiar cuenta, empresa, permisos o recorrida; descarta respuestas asincrónicas obsoletas.
- No se descarga el archivo al navegador para comprobar su hash. La verificación de 2 MiB tiene un costo transitorio de CPU/IO en backend solo cuando el usuario la solicita explícitamente. No se implementa integridad de archivos de más de 2 MiB ni verificación en lote.

## Pruebas

- **Puras:** `backend/test/evidenceIntegrity.test.js` para hash correcto, corrupción mismo tamaño, tamaño distinto, legacy sin hash y límite 2 MiB; `frontend/test/evidenceIntegrityPresentation.test.js` para rechazar respuestas inválidas.
- **PostgreSQL/PostGIS real:** en `backend/test/scoutingWorkflow.pg.mjs` comprueba subida real, reenvío idempotente, corrupción del bytea, alteración de metadatos, eliminación/restitución del hash, blob ausente, blob superior a 2 MiB y permisos cruzados con dos operadores/tenants. Todas las mutaciones de prueba ocurren en la **base descartable CI**, restauradas antes de salir del escenario.
- **UI/contrato:** `frontend/test/evidenceIntegrityUI.test.js` comprueba el endpoint protegido, la lectura SQL acotada, ausencia de bytes en respuesta, acción individual, invalidación de sesión y prohibición de mutar la cola.
- Gates: frontend, backend, build React, PostGIS RLS y Chromium offline **sobre el HEAD exacto** de la PR antes de merge.

## Pendientes

Verificación de carga y latencia en dispositivos físicos y redes del campo, rate limiting/telemetría operativa en piloto, integridad programada por lote si se diseñan workers dedicados, almacenamiento externo eventual, e2e nativo iOS/Android y despliegue/staging. No hay migraciones, ni cambios de estructura, ni despliegue en este bloque.
