# Piloto SedeAgro 0.1 — reintento seguro de recorridas tras recarga

**Issue #207, coordinación #18, release #130 NO-GO.**

El backend ya tenía idempotencia durable `POST /scouting/runs` (tabla `scouting_run_create_requests` tenant+actor+UUID con FORCE RLS, serialización transaccional, fingerprint canónico, tombstone al borrar el run). El frontend retenía el UUID sólo en memoria y lo perdía al cerrar la pestaña.

## Contrato frontend

- Sólo tras un login live validado, rol `tenant_admin` o `agronomic_coordinator`, membership, tenant, actor y `scouting` entitlement se desbloquea el modal. Cargar opciones de lotes y personas nunca establece autenticación.
- Antes de POST, la UUID y payload exacto se guardan en `sedeagro-scouting-run-recovery` IndexedDB mediante AES-256-GCM con clave no exportable y AAD `sedeagro:scouting-run-recovery:v1:<scope>:<uuid>`. Un fallo de escritura/cifrado impide el primer HTTP POST.
- Una sola operación pendiente por actor/tenant/rol y navegador. Dos pestañas no sobrescriben el primer COMMIT gracias a un `add` atómico en IDB.
- Al volver a abrir con autenticación verificada, la operación original se descifra y presenta como **Confirmación pendiente**. No hay sincronización ni POST en el efecto de recuperación. El botón `Reintentar el mismo envío` conserva bytes, fechas ISO y UUID, no interpreta la fecha planificada otra vez. Backend vuelve a verificar cada autorización.
- Al recibir ACK exacto de la recorrida (ID, tenant, campaign_field_id, responsible, estado, summary, fecha y `replayed` boolean), se elimina mediante compare-and-delete por UUID y se anuncia el alta.
- Ante ACK ambiguo o revocación, conservar el envío original para reintento tras revisión. El botón `Descartar tras revisar Recorridas` requiere confirmación explícita: el operador debe comprobar si se creó antes de descartar.
- Aislamiento: el journal de campañas instalado en `sedeagro-campaign-recovery` preserva su versión IDB, almacenes `pending-creates`/`scope-keys` y AAD originales `sedeagro:campaign-recovery:v1:`; el refactor **no migra ni borra bytes anteriores**. El journal de recorridas es otro DB y dominio. No mezcla observaciones fotográficas de `sedeagro-offline-sync`.

## QA

`frontend/test/scoutingRunRecoveryStore.test.js` cubre wiring, separación y validación estática. El harness Playwright `frontend/test/offlineBrowser.mjs` debe comprobar recarga con WebCrypto/IDB real, cifrado del resumen, tenant ajeno, otro tab, CAS por UUID, falta de overwrite y separación de campañas. Regresión anterior de recuperación de Campañas debe continuar verde.

**No certifica que la sesión backend pueda restaurarse sin internet.** MOB-05 #163 permanece abierta. Un segundo dispositivo/navegador no comparte este journal local: antes de recrear una recorrida hay que verificar el listado y autorización del backend. Un navegador con almacenamiento eliminado puede perder el cuerpo pero no el recibo del backend.

Staging autorizado y Android Chrome / iOS Safari físico: `NOT_RUN`; release #130 `NO_GO`; ningún deploy ni cambio de backend/DB.
