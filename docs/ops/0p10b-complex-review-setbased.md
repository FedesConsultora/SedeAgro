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

## Primera corrida emparejada medida y validada

El run premerge [#39439270858](https://github.com/FedesConsultora/SedeAgro/actions/runs/39439270858), PR HEAD `516970453722022dbd00b5cf6af269c7ff008bf7`, terminó `COMPLETED SUCCESS` con **4/4 jobs**, primer intento. Linux x64, 4 CPUs lógicas, Node 22.23.3, PostgreSQL 16.4. Criterios `PERF_STATES`:

- **240 órdenes**: `awaiting_report 60`, `ready_for_closure 60`, `self_authored 60`, `awaiting_inputs 12`, `rejected_exception 12`, `pending_exception 12`, `awaiting_evidence 4`, `human_review 20`.
- **1200 órdenes**: respectivamente 300, 300, 300, 60, 60, 60, 20 y 100. Los ocho estados se ejercitan contra los constraints y el aislamiento PostgreSQL real, no mediante mocks.

**Resultados del mismo runner**, `Execution Time` de PostgreSQL p95 por 7 `EXPLAIN ANALYZE` por caso:

| Filtro | Candidatas | Baseline | Optimizado | Máximo loops antes → después | Shared hits antes → después |
| --- | ---: | ---: | ---: | ---: | ---: |
| `blocked` / todos | 240 | 1,722 ms | 0,647 ms | 240 → 100 | 811 → 326 |
| `review` / todos | 240 | 1,654 ms | 0,422 ms | 240 → 20 | 811 → 86 |
| `blocked` / todos | 1200 | 23,634 ms | 2,468 ms | 1200 → 500 | 41391 → 1670 |
| `review` / todos | 1200 | 19,180 ms | 1,519 ms | 1200 → 100 | 41391 → 470 |
| `review` / application | 1200 | 9,049 ms | 1,381 ms | 400 → 100 | 13979 → 470 |

La optimización elimina buena parte de los `Nested Loop` correlacionados, pero **no necesariamente todos**: el plan todavía puede recorrer filas clasificadas con loops, y puede costar más para bases mucho más grandes o distinta distribución. En el caso `review/application` de 240 órdenes, el tiempo cliente medido con instrumentación fue ligeramente mayor después, aunque el servidor mejoró. No se establece un SLO, mejora porcentual universal ni extrapolación a producción.

**Invariante crítica:** el harness obtuvo `parity:true` y la igualdad exacta de IDs y orden para las 11 combinaciones de tipo/estado en ambas escalas; rechazó explícitamente cualquier desvío de resultado. Los logs contienen las 44 líneas por modo/escala y evidencias de RLS. Antes de integrar un commit de documentación nuevo se requiere otro run sobre ese SHA y posmerge independiente de `main`.
