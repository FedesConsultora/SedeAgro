# 0T.11 — Revisión independiente estructurada y respaldo íntegro por tipo de orden

## Problema confirmado
El flujo 0T.9 aceptaba `decision: verified` sin conservar **qué comprobó** coordinación. 0T.10 vinculó archivos privados y SHA-256 a cada parte, pero la aprobación no exigía examinarlos ni comprobar su integridad. Esto dificultaba auditar una aplicación, una fertilización o un parte sin adjuntos. Esta entrega **no demuestra físicamente que el trabajo ocurrió**.

## Nuevo contrato
`POST /api/v1/work-orders/:id/executions/:executionId/review` mantiene `orders.write`, membresía vigente, tenant/orden y reviewer distinto de autor, transacción con bloqueo de orden, rechazo con motivo de 10–500 caracteres y exclusión de re-review.

**Para aceptar** se exige:
```json
{
  "decision": "verified",
  "checklist": {
    "time_checked": true,
    "area_checked": true,
    "result_checked": true,
    "operation_checked": true,
    "evidence_basis": "reviewed_files"
  }
}
```
Todos los booleanos deben ser verdaderos y `checklist` no permite propiedades inesperadas. El revisor declara haber contrastado ventana temporal, superficie, resultado y detalles propios de la operación. No son sensores. Para un parte sin adjuntos, `evidence_basis: "no_files"` documenta expresamente la ausencia; **aplicación** y **fertilización** siempre requieren al menos un archivo privado, por lo que `no_files` se rechaza 409. Si hay archivos, `reviewed_files` debe corresponder a los adjuntos efectivamente existentes y cada blob pasa comprobación de **tamaño y SHA-256** antes del update de aprobación. Un archivo ausente o corrupto impide verificar el parte (409); los bytes no ingresan al audit log.

**Para rechazar** continúa el contrato `{"decision":"rejected","reason":"..."}` y la propuesta de un parte corregido. El rechazo no admite checklist afirmativo. Operaciones de revisión usan el mismo bloqueo transaccional de orden que la carga 0T.10, y un error deja el reporte `submitted`. La API nunca acepta directamente valores de tipo/usuario/tenant del navegador.

## Persistencia y compatibilidad
La migración `202610160001_execution_review_checklist.js` agrega `work_order_executions.review_checklist jsonb` con constraint de estructura y lo vincula solo a `review_status='verified'`. Los partes de revisión anteriores quedan en **NULL** sin generar comprobaciones retrospectivas ficticias. Se mantiene historial por orden, FORCE RLS y FK tenant existentes. El rollback aborta si hay algún checklist: guardar/exportar información antes de modificar esquema. No se alteraron los archivos de scouting ni el storage.

## Interfaz
En cada parte pendiente, solo coordinación ajena al autor ve cuatro casillas explícitas y selección de respaldo documental; el texto del cuarto control varía según el tipo (siembra, cosecha, fertilización, riego, inspección, etc.). El frontend rechaza una aceptación incompleta, pero **el servidor siempre revalida**. Si no existe un checklist para una aceptación histórica, la UI informa «Revisión histórica, sin checklist estructurado», y no simula controles realizados.

## Verificación y límites
Unit policy/backend: requerimientos según tipo, booleans falsos/strings, diferencia entre `reviewed_files` y `no_files`. Unit frontend: payload exacto, persistencia de legacy, copy. PostgreSQL/PostGIS 2 tenants: rechazo existente, autor distinto, checklist ausente o false 422, inconsistencia archivos 409, `application` requiere evidencia privada, tamper SHA impide revisión y recuperación posterior, auditoría de revisión sin duplicados, bloqueo al cierre, backup/restore y RLS. GitHub Actions valida build, unit, integración/Chromium por SHA exacto. Sin despliegue ni aceptación física.

**Límites**: los checks son declaraciones humanas de revisión; incluso bytes íntegros no demuestran origen/ubicación/fecha real ni cumplimiento agronómico. La obligación de adjuntos no equivale a receta de aplicación, validación profesional, dosis real ni prueba GPS. La política se aplica a nuevas aceptaciones; órdenes antiguas verificadas no cambian de estado. Próximos bloques posibles: registrar cantidades de insumos **efectivamente informadas** separadas del plan, y checklist adaptativo de intervención profesional según cultivo/producto sin inventar lecturas.
