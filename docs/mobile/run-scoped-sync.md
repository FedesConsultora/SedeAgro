# 0S.8 — Sincronizaciones enfocadas en una recorrida

Desde **Monitoreo → abrir recorrida → Capturas locales → Ver Sincronizaciones**, SedeAgro ahora abre Sincronizaciones con el identificador de esa recorrida. Es una navegación de la aplicación, **no** una URL pública ni una autorización nueva. El servidor ya comprobó el acceso a esa recorrida al mostrar su detalle.

## Pantalla y origen de los datos

- Se muestra un encabezado **Recorrida seleccionada** y el botón **Ver todas las recorridas**. Al quitar el filtro se vuelve al funcionamiento anterior, sin perder registros.
- **En este dispositivo:** se muestran solo borradores IndexedDB cifrados de la cuenta/empresa activa cuyo `runId` y `body.operations[0].payload.scouting_run_id` coinciden exactamente. Otras recorridas **siguen almacenadas** y no se modifican.
- **Conciliar observaciones:** recibe únicamente los borradores visibles. El cotejo sigue usando los 100 recibos personales más recientes y vuelve a validar los datos de la cuenta, clave de idempotencia y resultado del servidor antes de permitir retirar un borrador o recuperar su foto.
- **Recibos del servidor:** el listado de sincronizaciones no contiene una relación independiente con la recorrida. Se atribuye una fila **solo** cuando `SyncOperations[].result.scouting_run_id` del servidor coincide con la recorrida enfocada. Si un envío está fallido, es histórico o su operación carece de ese resultado, **no se le asigna una recorrida por suposiciones** y puede quedar fuera del filtro aunque exista en PostgreSQL. El endpoint devuelve como máximo 100 lotes; la ausencia de uno no prueba que nunca se procesó.
- **Referencias no válidas:** nunca fuerzan la vista a «todas»; se explica la referencia inválida, se vacían los listados filtrados y se deshabilita el envío hasta retirar el filtro.

## Semántica del botón Enviar

El sincronizador de fondo `offlineQueue.flush` trabaja por **cuenta/empresa**, con idempotencia para todos los lotes elegibles. Un filtro visual **no** implica envíos selectivos. Por eso, cuando existe una recorrida enfocada, el botón se presenta como **Enviar todos mis pendientes** y confirma explícitamente que procesará todas las recorridas de la cuenta.

No se añadió un flujo paralelo de sincronización por lote o recorrida; no se cambia ningún payload, foto, GPS, UUID, Web Lock ni borrador offline. Al retirar el filtro tampoco se genera una escritura.

## Seguridad y QA

El frontend mantiene los controles de navegación `canNavigateView`. Las lecturas de IndexedDB se mantienen dentro de `sessionScope(tenant,usuario)`; los recibos respetan la autenticación/RLS del backend. Las respuestas tardías de otras sesiones se descartan mediante los guards ya existentes en `SyncPage`.

Pruebas automatizadas puras y estructurales: UUID válido/inválido, varias recorridas y empresas, payload local inconsistente, recibos incompletos, coincidencia real en `SyncOperations.result`, pantalla, navegación, advertencia de envío global y no mutación. CI real de frontend, build y PostgreSQL/Chromium en el HEAD exacto del PR.

Para aceptación física antes del piloto: recorrer dos lotes diferentes con capturas locales, entrar desde uno, comparar la lista completa tras quitar el filtro, intentar enviar con confirmación explícita, perder/restituir conexión y validar reintentos de fotos pendientes en iPhone y Android. Este bloque **no despliega producción** ni valida GPS físico.
