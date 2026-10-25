# Piloto — Asignar lote a campaña con evidencia de acuse

**Contrato:** `POST /api/v1/campaigns/:campaignId/fields`. Documenta únicamente código del piloto y criterios para operadores. Base `main@1178bff482f50c2b7f46f29919f6c8229a6270c3`, coordinación #18, matriz #166, release #130 NO-GO.

## Defecto observado (antes de este PR)

En `AssignFieldModal` el fallo de `GET /fields` o `/catalogs/bootstrap` podía cargar silenciosamente `mockData.fields` y `mockData.cropTypes`, mezclando datos demo con una sesión live y permitiendo enviar IDs inexistentes de otra fuente. El doble toque antes de renderizar `saving` podía despachar dos POST no idempotentes. El formulario trataba cualquier 2xx como alta confirmada, no distinguía ACK perdido después de COMMIT ni descartaba respuestas tardías tras cambiar de empresa, usuario, rol o campaña.

## Implementación

1. El selector live depende de sesión autenticada con tenant, actor, rol de planificación `tenant_admin` o `agronomic_coordinator`, entitlement `campaigns` y UUID de campaña. El backend continúa verificando `campaigns.write`, `tenant_id` y FORCE RLS; el cliente no concede permisos.
2. Los listados live se validan y guardan junto con el scope y la identidad de API. Si falla un GET, el modal muestra el error y permite reintentar, **sin recurrir a registros demo**. Las respuestas de otra sesión no se pintan ni habilitan el envío.
3. Se valida que el lote pertenezca al catálogo de esta empresa, el cultivo esté disponible y la variedad pertenezca al cultivo elegido. Cambiar cultivo borra la variedad seleccionada anteriormente.
4. Se validan fechas calendarias reales de siembra/cosecha, orden cronológico y rendimiento positivo o cero hasta dos decimales, dentro de DECIMAL(12,2). Los campos opcionales vacíos se omiten en el POST, y un rendimiento cero se conserva.
5. Un ticket adquirido sincrónicamente antes del primer await bloquea dobles envíos. X, Escape, fondo y Cancelar no cierran mientras el POST está pendiente. Una respuesta HTTP/2xx sólo confirma éxito si el recurso devuelto incluye UUID y tenant, campaña, lote, cultivo, variedad, fechas, rendimiento y estado originales.
6. Una respuesta ambigua (timeout, pérdida de ACK o 2xx inconsistente) bloquea nuevos envíos desde esa apertura, muestra indicaciones de comprobar el listado y no inventa éxito.
7. Modo demo no simula una asignación persistida.

## Evidencia técnica

`frontend/test/campaignFieldAssignSafety.test.js` contiene regresiones Node para autorización visual, catálogos inconsistentes, ID de empresa ajena, cultivo-variedad, fechas imposibles, período invertido, precisión decimal, validación de recibo y optional nulls, doble click asíncrono, stale ticket, y wiring del modal. CI PostgreSQL/Chromium verifica el build y contratos generales, no sustituye pruebas físicas.

## Pruebas de operador pendientes

- Tenant A con admin/coordinador: asociar un lote válido a una campaña y comprobar exactamente una fila del backend con `campaign_id`, `field_id`, `crop_type_id` y UUID persistidos.
- Forzar error de GET: confirmar que el modal no muestra lotes demo ni permite asignación. Reintentar y comprobar recuperación.
- Cambiar tenant, rol o campaña mientras los GET/POST están pendientes. No mostrar nombres anteriores ni cerrar modal de la sesión nueva por ACK viejo.
- Simular dos toques simultáneos y timeout después del COMMIT. Comprobar un POST en esta apertura; revisar lista de Campañas antes de otra operación.
- Fecha imposible (2027-02-29), cosecha anterior a siembra, variedad ajena al cultivo y rendimiento inválido: rechazo previo a red.
- Repetir en móviles Android e iOS reales, con cambio de conectividad y sesión. **NOT_RUN** hasta aceptación real.

## Límite de garantía y acciones siguientes

Este bloqueo es por **apertura de formulario**; el servidor sigue creando un `campaign_fields.id` nuevo en cada POST y no acepta client-request UUID idempotente para asociaciones de lotes. Una pestaña/dispositivo distinto o refresh puede crear duplicados. Abrir un trabajo backend separado para idempotencia persistente si los operadores reportan reintentos ambiguos; no imponer UNIQUE por lote/campaña sin estudiar campañas con múltiples ciclos/siembras. No desplegar, no tocar migraciones ni RLS y no declarar GO por CI.
