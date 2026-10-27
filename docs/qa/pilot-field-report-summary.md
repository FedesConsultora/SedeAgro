# SedeAgro 0.1 — Resumen de lote privado y acotado (#251)

## Defecto confirmado por lectura de fuente

Antes de este bloque `GET /api/v1/reports/field/:fieldId` obtenía cada orden del lote sin `LIMIT` sólo para calcular abiertos/cerrados y devolver cinco; además serializaba todas las observaciones de la última recorrida, incluidos `notes` que el panel nunca mostraba. El crecimiento de los lotes podía disparar transferencia/memoria y revelar notas innecesarias al cliente. El endpoint de resumen tampoco marcaba explícitamente `Cache-Control: private, no-store`. Estas son condiciones del código, no una explotación externa reportada.

## Contrato 0.1 ajustado

`GET /reports/field/:fieldId` mantiene `data.field`, `data.activeCampaignField` y `data.workOrdersSummary.open/closed/recent`; agrega `lastScoutingRun.observationSummary: {count, hasCritical}`. El panel web utiliza exclusivamente ese resumen para KPI y alerta crítica y deja de depender de `lastScoutingRun.ScoutingObservations` (el arreglo ilimitado ya **no se entrega**). Es un cambio explícito del contrato interno de resumen, **no** del detalle de Monitoreo ni de las exportaciones.

- El servidor filtra por tenant y lote también en consultas ORM, además de conservar RLS en la transacción.
- Cuenta observaciones y críticas mediante agregaciones del servidor, sin leer `notes`, fotos, GPS ni texto de observaciones.
- Cuenta abiertas/cerradas con las mismas listas de estados ya usadas en la UI, y sólo lee las cinco órdenes recientes, ordenadas por `created_at DESC, id DESC`.
- La respuesta y los errores envían `Cache-Control: private, no-store`. UUID inválido devuelve 422; lote inexistente/ajeno 404; rol sin derecho `reports.read` 403.
- No se modifica el contrato ni los límites de `export.csv/.pdf/.xlsx`, el worker, permisos, membresías, migraciones, ni índices. Los conteos son exactos para el snapshot transaccional de cada petición, no para una futura actualización.

## Prueba y límites

`backend/test/fieldCsvExport.pg.mjs` amplía la aceptación HTTP contra rol no propietario con dos empresas: carga 203 observaciones en un lote (una crítica) y 343 órdenes (302 abiertas, 41 cerradas), verifica conteos, últimas cinco, ausencia de notas sentinela en JSON, tamaño de respuesta acotado, `Cache-Control`, invalidación UUID, 403/404 y compatibilidad de exportaciones. Los tests frontend aseguran que el panel interpreta los dos agregados, no arreglos históricos.

El rendimiento p95 con 5k/20k/50k órdenes, concurrencia real y despliegue autorizado sigue en issue #143. Seguridad multiempresa `memberships` sin FORCE RLS (#232), inicio offline sin sesión recuperable (#163) y aceptación física quedan sin resolver. Esta mejora **no autoriza staging, VPS ni producción**: release #130 sigue NO-GO.
