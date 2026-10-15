# 0S.12 — Procedencia y disponibilidad de evidencias en recorridas

## Uso de campo

En **Monitoreo → Detalle de recorrida → Verificación de fotografías y archivos** aparece un panel adicional sólo tras haber cargado con éxito el detalle autorizado de una recorrida real. Mantiene separadas tres fuentes:

1. `GET /api/v1/scouting/runs/:id` confirma qué recorrida puede leer el usuario y su asignación vigente.
2. **Nuevo** `GET /api/v1/scouting/runs/:id/evidence-status` devuelve metadatos mínimos de hasta 100 evidencias recientes de la misma recorrida, ordenadas por creación descendente, y el booleano `bytes_available` determinado desde `evidence_blobs` bajo RLS. No transmite contenido binario, rutas privadas, nombres de archivos ni hash.
3. `offlineQueue.list(session)` consulta exclusivamente los borradores cifrados AES-256-GCM de la cuenta/empresa activa. Las fotos con `client_upload_id` se comparan con los registros del servidor por **UUID estable, actor actual, mime, tamaño y observación** si existe `syncedObservationId`.

La UI diferencia fotografías con blob privado presente, registros solo con metadatos, colisiones de identidad, ausencia en la consulta y registros por fuera de la ventana de 100. Muestra un resumen de los diez archivos recientes del servidor, sin nombre ni fotos y sin identidad de otros operadores.

## Contratos y seguridad

**Backend**: `scoutingRouter.get('/runs/:id/evidence-status')` hereda el entitlement scouting y exige `scouting.read`; `findRun()` garantiza asignación actual para `scout` (404 ante no autorizado). `EvidenceAsset` se filtra por tenant y se asocia con `ScoutingObservation` del run; `EvidenceBlob.findAll` selecciona sólo `evidence_id` con `tenant_id` explícito. La consulta es de solo lectura, siempre usa `req.dbTransaction` y RLS; respuesta con `Cache-Control: private, no-store`, `limit:100` y `has_more` mediante lectura de una fila adicional.

**Estado real**: `bytes_available:true` sólo demuestra la **existencia de una fila blob** para esa evidencia y tenant. No comprueba SHA-256, longitud real del blob ni una descarga exitosa. `bytes_available:false` indica metadatos sin blob en la base consultada, pero no dice por qué. El endpoint de contenido privado autenticado `GET /scouting/evidence/:id/content` continúa como única manera de recuperar los bytes.

**Correlación offline**: aun si aparece una foto con bytea, el panel no ejecuta `discard`, `confirmApplied`, `recoverPhoto`, `flush` ni actualiza IndexedDB. La cola puede conservar una foto después de un ACK perdido, pero la limpieza y recuperación pertenecen exclusivamente al proceso de Sincronizaciones y a su propio control de idempotencia y CAS. No confundir "foto vista en servidor" con "observación confirmada por recibo de sync", ni con verificación criptográfica.

**Limitaciones**: hasta 100 evidencias por consulta, no toda la vida de la recorrida; cuando `has_more` es true, un upload puede existir fuera de esa ventana. Una ausencia no prueba que la subida haya fallado, especialmente con otra pestaña enviando, sesión caducada o después de cambiar de dispositivo. Los documentos PDF cargados online también figuran como metadatos, pero no se emparejan con fotos offline.

**Desconexión y revocación**: el estado verificado se invalida al perder conexión, cambiar tenant, actor, rol, módulo o run. Las respuestas tardías se descartan por `requestSeq` y `contextRef`; no se conserva el éxito anterior bajo un error. Refresco explícito, al recuperar Internet, al recuperar visibilidad y cuando cambia la cola local.

## Verificaciones

- Backend `evidenceProvenance.test.js`: privacidad de salida, límite y diferenciación metadata/blob.
- PostgreSQL/PostGIS `scoutingWorkflow.pg.mjs`: upload real, replay idempotente, lectura por scout asignado, rechazo scout no asignado y otro tenant; eliminación y restauración **solo en base descartable de CI** del blob para comprobar el caso metadata-only, sin alterar el resto de pruebas.
- Frontend `runEvidenceProvenance.test.js`: cotejo por actor, formato, tamaño, observación y UUID de carga, datos inválidos, estado de incertidumbre y no filtrado de contenido local.
- Frontend `runEvidenceProvenanceUI.test.js`: autorización, errores offline/cuentas cambiadas, no mutación de borradores e integración protegida con ScoutingPage.
- CI exact HEAD: frontend/backend test, build React/Vite, DB/PostGIS/RLS real y Chromium offline.

## Riesgos de aceptación pendientes

Falta ejecutar en dispositivos físicos iOS/Android, desconexiones de larga duración, cambios de cuenta, cachés navegadores y archivos antiguos fuera de 100. La solución no despliega ni altera schema/migraciones/roles/entitlements, por lo que no constituye aceptación del piloto.
