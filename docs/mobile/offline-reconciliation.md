# 0S.5 — Conciliación de observaciones offline con recibos reales

La pantalla **Sincronizaciones → Conciliar observaciones** contrasta los borradores cifrados de la empresa y cuenta activas con `GET /api/v1/sync/my-batches` protegido por backend/RLS. No utiliza `GET /sync/batches` (listado global de coordinadores) para tomar decisiones sobre borradores personales.

## Estados verificados

- **Observación aplicada:** `status=processed`, operación `applied`, la clave de idempotencia, `client_id`, `submitted_by`, `entity_client_id`, tipo/operación y `result.scouting_run_id` coinciden con el borrador, con un `observation_id` UUID válido. Si no hay fotografía pendiente, es posible retirar **solo la copia local**, luego de una confirmación explícita y una **segunda consulta fresca** al servidor.
- **Observación aplicada · fotografía pendiente:** el mismo recibo confirma únicamente el registro de observación. La foto exige una confirmación independiente de `POST /scouting/observations/:id/evidence`. El panel **nunca permite limpiar** estos borradores, incluso cuando `syncedObservationId` exista.
- **Lote visto, sin aplicación:** `received`, `processing` o `failed` NO se presentan como aplicados.
- **Recibo inconsistente:** un duplicado de idempotencia, identidad diferente, resultado malformado o `observation_id` discrepante **bloquea** la conciliación; no borra el borrador.
- **Sin recibo listado:** los endpoints muestran sólo los **100 recibos más recientes**. La ausencia no significa que el servidor no lo aplicó; se conserva el mismo payload, misma clave y misma foto para los reintentos del mecanismo existente.
- **Consulta fallida / almacenamiento ilegible:** error explícito; no se reemplaza por cero recibos ni se ejecuta limpieza.

## Seguridad y concurrencia

El modelo puro `offlineReconciliation.js` falla cerrado frente a respuestas de otra cuenta. Se comparan los recibos con el `user.id` de la sesión activa, y el backend resuelve el tenant del JWT/cabecera autenticados. `SyncPage` deja de mostrar borradores o recibos antiguos ante cambios de usuario/tenant/rol, antes de que las peticiones nuevas terminen.

La opción **Retirar copia confirmada** requiere consentimiento explícito, otra consulta a `/sync/my-batches` y una nueva comparación con el registro persistido **actual** de IndexedDB dentro de `withLock(scope)`. No borra el dato de PostgreSQL ni los registros con fotografías. No compite con `offlineQueue.flush` en la misma pestaña; `navigator.locks`, cuando está disponible, serializa entre pestañas. Si otra pestaña ya procesó el registro, se informa sin recrear datos.

No se almacena nuevo dato sensible en localStorage, sessionStorage ni fuera del borrador cifrado. El resultado de conciliación es efímero (estado de React).

## Pruebas / aceptación

```bash
npm --workspace frontend run test
npm --workspace frontend run build
```

La suite comprueba aislamiento, identidad completa de recibos, lotes no aplicados/ambiguos, diferencia GPS/foto, borrados autorizados, prohibiciones y simultaneidad. GitHub Actions además verifica IndexedDB + cifrado en Chromium y PostgreSQL de prueba; verificar el **HEAD exacto** del PR antes de merge.

Antes del piloto hacer aceptación en iPhone/Android: desconectar después de que el servidor aplique el lote, recargar la pantalla, verificar coincidencia al reconectar y conciliar; repetir con foto cuya carga falla, sesión cambiada, ventana duplicada y recibo ausente por paginación. No confundir una conciliación positiva de la observación con la carga final de la evidencia.
