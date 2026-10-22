# PILOT-RP-AUTH-FENCE — reportes de lote sujetos a identidad y permisos vigentes

## Defecto de continuidad y privacidad

`FieldReportCard.load()` antes hacía `await api.getFieldReport(fieldId)` seguido de `setReport(res.data)` sin verificar la identidad original de la petición. Un usuario podía cambiar de empresa, rol, autorización o lote mientras la respuesta estaba en vuelo y el componente conservaría un resumen viejo que combina campañas, monitoreos y órdenes. El mecanismo previo de exportación `currentScope` comprobaba sólo tenant:user y referencia API, pero **no cambios de rol ni entitlements dentro del mismo tenant**. Lo mismo ocurría en el polling de `ReportJobsPanel`.

No estamos afirmando un incidente real de filtración; corregimos una ruta de render y descarga de información sensible cuyo valor podía provenir de una autorización anterior. El servidor sigue siendo la autoridad de RBAC y FORCE RLS.

## Implementación

- El helper puro `reportAccessContext(session, dataMode, fieldId?)` enlaza tenant+usuario autenticado, rol efectivo, indicador de administrador de plataforma, entitlements únicos/ordenados y lote (para ficha); `null` para demo o sesión no verificada. Un cambio real de autorización **altera la clave de ámbito**, sin remounts por simple reordenamiento de grants.
- `ReportsPage` usa esa clave al renderizar `FieldReportCard` y `ReportJobsPanel`: al cambiar permisos/identidad, React desmonta ambos árboles y limpia estados anteriores, timers, solicitudes pendientes y datos en memoria del componente.
- `FieldReportCard` mantiene además defensa local: `reportState` se etiqueta con contexto y API de origen y **no se representa durante el render** si difieren; la generación `loadSequence` invalida resoluciones tardías, `loadInFlight` bloquea doble pulsación antes de render y el efecto de cambio de autoridad borra el resumen, errores, exportaciones y estados de carga.
- `confirmFieldReportResponse` exige `response.data.field.id === fieldId` antes de mostrar un resumen: es el contrato real que devuelve el endpoint `GET /reports/field/:fieldId`.
- Las exportaciones CSV/PDF/XLSX conservan las reglas previas de formato, fechas y tamaño; ahora los dos controles existentes antes de abrir la descarga cotejan un contexto que incluye el rol y los permisos. `ReportJobsPanel` también invalida su polling y los trabajos visibles según la clave de autorización completa.
- Los ejemplos del modo demo siguen separados de respuestas privadas reales, y no se persisten cookies, tokens ni resúmenes de reporte en un almacenamiento nuevo.

## Pruebas / validación

`frontend/test/reportAccessContext.test.js` comprueba estabilidad con grants reordenados, mutaciones de tenant, cuenta, rol, entitlements, administrador y lote, contexto no autenticado, y rechazo de un HTTP 200 de otro lote. Tests de cableado verifican identificación por clave de los componentes, invalidación de generación y ausencia de descargas tras pérdida de autoridad.

La aceptación física en staging privado requiere mantener una consulta de resumen y una exportación pendiente con conexión lenta, degradar permisos desde otra sesión, cambiar a otro tenant, completar la respuesta anterior y verificar que **no se muestra resumen ni se activa descarga con la autorización obsoleta**. Repetir con trabajos asíncronos y usuario productor (sin reports.read), además de dos pestañas. No equivale a una revocación en tiempo real: el cliente reconoce cambios de contexto cuando la sesión local se actualiza; el servidor debe rechazar accesos una vez revocados.

## Fuera de alcance

No cambia contratos REST ni su RLS, ni permisos `reports.read`, modelos, worker, límites de exportación, archivos de seguridad de release ni el comportamiento offline de recorridas. La aprobación del piloto permanece en **NO-GO** (#130); la continuidad tras cold-start sin red (#163) y la aceptación Android/iOS reales siguen sin certificar.
