# 0S.15 — Historial resiliente de evidencias (lectura, rendimiento, redes móviles)

## Cambios funcionales
Sobre la paginación keyset del bloque 0S.14, Monitoreo sigue mostrando **diez evidencias por página** y verificaciones SHA-256 manuales, pero ahora las lecturas HTTP en tránsito se **cancelan con AbortController** cuando el usuario abandona una página, cambia el usuario/tenant/run/rol o pierde Internet. La llamada `getRunEvidencePage` envía `signal` al `fetch` existente y `silent:true` para no mostrar mensajes de error por abortos esperados; los demás endpoints y el tratamiento global de errores no cambian.

Al desconectarse el navegador invalida la respuesta y elimina la evidencia de que el archivo estaba disponible en ese instante. Al reconectarse no intenta continuar una cadena de cursores guardada antes de perder señal: **vuelve a la primera página**. Si el backend rechaza un cursor con `400/EVIDENCE_CURSOR_INVALID`, muestra una advertencia con la acción **Reiniciar historial**, sin confundirlo con ausencia de archivos ni esconder un error de permisos 401/403/404. Para errores de red o backend se ofrece **Reintentar esta página**, además de reiniciar. El helper `advanceEvidencePage` rechaza cursores vacíos, repetidos o cíclicos antes de navegar; el contenido de una página antigua no se presenta como resultado nuevo.

La lista de fotografías locales permanece **cifrada e independiente**; ninguna acción aquí cambia `offlineQueue`, IndexedDB, idempotencia ni almacena nuevos bytes. La ausencia de una foto local en la página consultada sigue siendo **información insuficiente**, no un fallo o autorización para borrar. La verificación SHA-256 solo se ejecuta por decisión explícita y para evidencias visibles.

## Índices de lectura
Nueva migración aditiva y reversible:
`backend/db/migrations/202610150001_evidence_history_read_indexes.js`
- `idx_evidence_scouting_tenant_history`: B-tree parcial en `evidence_assets (tenant_id, created_at DESC, id DESC) INCLUDE (scouting_observation_id) WHERE scouting_observation_id IS NOT NULL`. Facilita el orden solicitado por el cursor (sin incluir bytes).
- `idx_scouting_observations_tenant_run_id`: B-tree en `scouting_observations (tenant_id, scouting_run_id, id)` para hallar las observaciones que pertenecen a una recorrida.

Ambos son **índices únicamente**; no tocan filas, esquema de columnas, roles, FORCE RLS, triggers ni blobs. La migración usa `CREATE INDEX` normal: **requiere planificar una ventana de aplicación** en bases con muchos registros, porque PostgreSQL puede bloquear escrituras mientras construye índices. No se desplegó ni ejecutó en producción. Rollback: `down` elimina ambos índices por nombre. El índice acelera un posible plan de lectura, pero **no asegura latencia constante** en empresas con muchas recorridas o alta proporción de evidencias ajenas. Validar planes `EXPLAIN (ANALYZE, BUFFERS)` y latencias con distribución de datos representativa antes de piloto.

## Prueba real de volumen y seguridad
El gate `backend/test/scoutingEvidenceHistory.pg.mjs` crea en PostGIS descartable:
- **750 evidencias** de una recorrida con fechas empatadas cada tres filas;
- **250 evidencias ajenas** de otra recorrida del mismo tenant;
- índices verificados en `pg_indexes`.

La prueba recorre las 750 en **30 páginas de 25** mediante el endpoint real, compara IDs con el orden completo `created_at DESC, id DESC`, comprueba ausencia de duplicaciones, ausencia de bytes/hash en cada respuesta y `Cache-Control: private, no-store`. Durante la navegación reasigna temporalmente la recorrida: el operador antiguo debe obtener **404** y el nuevo puede consultar; otro tenant recibe **403**. Restaura la asignación y continúa con el cursor anterior, sin inventar un total de producción.

Además, `backend/test/evidenceHistoryIndex.test.js` audita DDL y rollback, `frontend/test/evidencePageNavigation.test.js` cubre cursores repetidos/errores distintos de permisos y `frontend/test/evidenceHistoryResilienceUI.test.js` verifica abortos HTTP, reset de red, reintento, privacidad y no mutaciones. Se mantienen los gates de unidad frontend/backend, build y Chromium offline.

## Limitaciones y aceptación
Los test estructurales de interfaz y Chromium offline existentes **no equivalen** a una aceptación física del historial paginado en iPhone/Android; falta ensayar cambios de conectividad reales, memoria, latencia, bloqueo de escritura al migrar índices, consultas con millones de filas y perfiles distintos de empresas. La paginación keyset tampoco es un snapshot histórico transaccional entre solicitudes; no hay un número global exacto. Sin producción/VPS/staging, nuevos buckets, descarga automática, GPS ni cambios de autorizaciones.
