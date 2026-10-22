# PILOT-SCOUT-PRIVATE-DOWNLOAD — Integridad antes de mostrar evidencia de recorrida

## Defecto verificado

Antes de este bloque, `GET /api/v1/scouting/evidence/:id/content` devolvía `content_base64` si existía una fila de `evidence_blobs`, sin calcular ni comparar el `content_sha256` de `evidence_assets` ni el `size_bytes` declarado. Un cambio accidental, corrupción de almacenamiento o importación histórica con metadatos incompletos podía mostrarse como fotografía válida. El mismo módulo ya ofrecía `/integrity` como endpoint independiente, pero el download **no estaba condicionado por ese resultado**. La descarga de evidencias de ejecución de órdenes sí era fail-closed.

## Corrección del contrato HTTP

- Requiere `scouting.read`, autorización del lote/recorrida y el tenant/usuario actuales; estos permisos no cambian.
- Reutiliza `getPrivateEvidenceByteLength`: `octet_length` de PostgreSQL sin transferir BYTEA en la primera consulta.
- Si falta el blob, devuelve **404 `SCOUTING_EVIDENCE_BYTES_MISSING`** sin bytes. Si el tamaño excede 2 MiB, no coincide con `size_bytes`, el hash falta/no es válido, o el SHA-256 difiere de los bytes actuales, devuelve **409 `SCOUTING_EVIDENCE_INTEGRITY_FAILED`**. No envía `content_base64` en ningún rechazo.
- Sólo tras `shouldReadEvidenceBytes` y lectura acotada `getBoundedPrivateEvidence` clasificada como `verified` se devuelve `data: {id,original_name,mime_type,size_bytes,content_base64}` intacta.
- Se configura `Cache-Control: private, no-store` y `X-Content-Type-Options: nosniff` en la respuesta válida. La descarga no invoca sistemas externos; todas las consultas comparten la transacción de seguridad RLS existente.

## Prueba real e implicaciones

La prueba integrada existente `backend/test/scoutingWorkflow.pg.mjs` crea tenants A/B, recorrida y evidencia binaria en base descartable PostGIS. Se amplía para pedir el contenido durante manipulación controlada del BYTEA con **igual tamaño pero diferente hash**, cambiar sólo `size_bytes`, borrar temporalmente el hash y eliminar temporalmente el blob. Cada intento debe responder sin Base64 (409, 409, 409, 404), restaurar la fila original y permitir descargar el mismo archivo íntegro. Se conservan los ensayos ya existentes de visibilidad por usuario, revocación de recorrido y replay idempotente.

No se corrige ni inventa metadatos para evidencias antiguas no verificables: necesitan revisión y reconciliación por un responsable. El endpoint público `/integrity` sigue permitiendo explicar si el documento está `missing`, `mismatch` o `unverifiable` sin exponer el SHA privado.

**Límites**: La prueba verifica la descarga HTTP backend/PostgreSQL, no el decodificador del teléfono ni la experiencia de la interfaz, ni la recuperación desde respaldos. iOS/Android reales, staging con TLS, #163 MOB-05 y #130 aprobación release siguen NOT_RUN/NO-GO. No cambia esquema, almacenamiento, cifrado, módulos de órdenes, Docker, CI ni API de subida.
