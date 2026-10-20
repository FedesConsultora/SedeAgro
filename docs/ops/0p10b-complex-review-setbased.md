# SedeAgro 0P.10B — Clasificación por conjuntos de revisión

## Motivación y alcance
El issue #140 documenta que los estados globales `blocked` y `review` todavía requieren una subconsulta LATERAL y agregados correlacionados por cada orden antes de paginar. Los estados `no_report` y `closure` ya cuentan con filtros `EXISTS/NOT EXISTS`, integrados en el PR #141.

Este bloque cambia únicamente el **predicado de pertenencia** a `blocked` y `review`, y no cambia los códigos de estado, la prioridad del clasificador humano, la autorización, el tenant activo, cursores firmados, paginación, ordenación, validación de evidencias, permisos, API ni el esquema.

## Semántica conservada
La consulta optimizada selecciona primero `work_orders` del tenant autenticado y partes `submitted`. Se apoya en `ux_work_execution_one_active` (unicidad de estado `submitted/verified` por orden y tenant), ya existente. Un parte `verified` pertenece a `closure`, mientras que una orden sin parte activo (incluido un historial únicamente `rejected`) pertenece a `no_report` y no puede ingresar a ninguno de los dos grupos complejos.

Dentro de cada conjunto, la precedencia de clasificación coincide con el SQL y la política JS anterior:

1. Parte propio → `self_authored`.
2. Insumos planificados sin declaración completa de ítems → `awaiting_inputs`.
3. Excepción `rejected` → `rejected_exception`.
4. Excepción distinta de `approved` → `pending_exception`.
5. Labor `application/fertilization` sin evidencia del parte → `awaiting_evidence`.
6. Resto → `human_review`.

Los conteos de insumos, flags de excepciones y presencia de evidencia se precalculan mediante `GROUP BY` por **tenant explícito validado como UUID**; la query también está sujeta a FORCE RLS de la transacción actual. No hay accesos cruzados al tenant ni incorporación de columnas confidenciales a la respuesta. La consulta es de solo lectura; el endpoint conserva el clasificador JS después de paginar, incluida su comprobación fail-closed `ORDER_REVIEW_STATE_MISMATCH`.

## Verificación en CI real
El benchmark sobre PostGIS migrado y rol runtime no privilegiado mide en **el mismo runner y mismo dataset** el `reviewQueueStateSql` histórico y el predicado por conjuntos. Por cada escala (240 y 1200 órdenes) se exige:

- Dos tenants, cero filas visibles de otro tenant, revisión explícita de no-superusuario/no-bypass RLS.
- Los **ocho estados** presentes en los datos de prueba: ausencia de parte, verificado, parte propio, falta de insumos declarados, excepción rechazada, excepción pendiente, falta de evidencia y revisión humana.
- `blocked` y `review` contrastados además con combinaciones de tipo; todas las 11 combinaciones existentes conservan **IDs y orden idénticos**, no solo el mismo conteo.
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 7 veces por modo, estado y escala, con p50/p95, loops, hits/reads y plan real. La variación entre runners impide afirmar una mejora porcentual productiva sin comparación directa.
- No se modifica la consulta base de diagnóstico y los estados optimizados anteriormente siguen siendo parte de la regresión.

## Restricciones
No agregar índices ni migraciones sin planes medidos. No mutar VPS/staging/DB privada, ni aceptar las seis vulnerabilidades moderadas de #137 como resueltas. Las métricas de CI no constituyen SLO de API ni certificación de release. Antes de cerrar la parte funcional de #140 verificar cuatro jobs SUCCESS en HEAD exacto del PR y workflow **independiente** de main posmerge, registrando SHA y URLs.
