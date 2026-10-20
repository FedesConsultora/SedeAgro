# 0P.10 — Filtros rápidos de revisión sin cambiar la autoridad transaccional

## Problema con evidencia

El [perfilador PostGIS #105](https://github.com/FedesConsultora/SedeAgro/issues/105) evidenció que `reviewQueueStateSql` se evalúa antes del límite de la bandeja. En el CI posmerge `64d523a...`, la consulta `no_report` visitó 240 y luego 1200 órdenes candidatas pese a devolver 51 filas, con PostgreSQL p95 1,769 → 8,063 ms en ese runner. Estas cifras NO son un SLO de API ni proyección productiva.

## Optimización conservadora

Para los dos únicos grupos cuya equivalencia puede demostrar la precedencia SQL sin leer insumos, excepciones ni evidencias:

- **`no_report`**: `NOT EXISTS` parte de ejecución con `review_status IN ('submitted','verified')` del mismo `tenant_id` y `work_order_id`. Un parte `rejected` por sí solo **no** deja de ser `awaiting_report`. La clave es la ausencia de parte *activo*.
- **`closure`**: `EXISTS` parte `verified` con idéntico `tenant_id`/orden. El CASE previo prioriza `verified` antes que revisor/insumos/excepciones/evidencias. Los índices y constraints existentes garantizan at-most-one activo, pero la condición de existencia es equivalente aun si hubiere una fila `submitted` histórica aparte.
- **`blocked` y `review`**: NO se simplifican. Conservan `reviewQueueStateSql` completo y su precedencia original. `all` no agrega predicado de estado.

El endpoint conserva `REVIEW_QUEUE_PAGE_SIZE+1`, filtros tipo/prioridad/due/título, modos de sort, contrato de cursor HMAC v7, identidad del actor, RLS, transacción, clasificación JS, prohibición de discrepancias y restricciones de autorización. No se crean índices ni migraciones; tampoco se cambia el clasificador de órdenes.

## Prueba de equivalencia y rendimiento

`scripts/benchmark-review-queue.mjs` ahora compara `baseline` (SQL anterior) contra `optimized`, **en la misma DB/rol transacción READ ONLY y dataset sintético de cada escala**:

1. Con 240/1200 órdenes y 36 adicionales en un tenant adversario, confirma rol runtime sin privilegios, `FORCE RLS`, conteo de filas propias y **cero ajenas**.
2. Para los once pares estado/tipo existentes, consulta la página sin EXPLAIN de ambos modos y comprueba igualdad **exacta del array ordenado de IDs**; el test falla si difieren.
3. Ejecuta 7 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` por modo/filtro/escala y publica p50/p95 de PostgreSQL, tiempos de instrumentación, loops y buffers, sin inventar datos.
4. Se incorporan partes históricos `rejected` sintéticos, además de órdenes sin ningún parte, para comprobar que `no_report` sigue siendo correcto. Los datos son eliminados al finalizar.
5. No se impone un umbral numérico arbitrario en runners compartidos; la optimización debe evaluarse comparando paridad y mediciones en el mismo run.

El PR necesita 4/4 jobs SUCCESS en su SHA exacto y CI independiente postmerge 4/4. La aceptación funcional de navegador y del rol RLS no es certificación de despliegue.

## Restricciones / próximos riesgos

Puede persistir costo proporcional a candidatos, pero con menor trabajo por candidato. Los grupos complejos `blocked` y `review` merecen un bloque ulterior y medición específica, sin forzar una reescritura que comprometa semántica. Siguen pendientes las seis alertas moderadas del backend (#137), QA foco modal (#86), staging TLS real, restore privado, Android/iOS y rollback operativo. **NO GO productivo por este PR**.
