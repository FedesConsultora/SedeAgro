# QA #105 — Perfil reproducible de PostgreSQL/PostGIS para filtros review-queue

## Riesgo que se valida

La bandeja de coordinación aplica `reviewQueueStateSql` **antes** de `LIMIT 51`: devolver hasta 50 órdenes no acota necesariamente el trabajo de SQL correlacionado sobre ejecuciones, insumos, excepciones y evidencias. El índice general `idx_work_orders_tenant_status` no garantiza escalabilidad de filtros dinámicos. No se asume que el API tenga un SLO medido, ni se aprueban índices por intuición.

## Evidencia ejecutable

El workflow de `tenant-rls` ejecuta `node scripts/benchmark-review-queue.mjs` después de aprovisionar el rol de menor privilegio y antes del ensayo de `pg_dump`/`pg_restore`. Requiere `CI=true`, `GITHUB_ACTIONS=true`, `SEDEAGRO_PERF_PROBE=I_ACCEPT_DISPOSABLE_POSTGIS_PERF_ONLY`, URLs en loopback a la misma base `*_test`, usuarios admin/runtime distintos y cuenta runtime sin `SUPERUSER`, `BYPASSRLS` ni propiedad de base.

Crea dos tenants sintéticos, dos miembros, un campo de trabajo y 36 órdenes en el tenant adversario. En el tenant medido inserta **240 y 1200 órdenes** de distintos tipos (application, sowing, harvest) y estados (sin parte, parte verificado, parte propio y parte sometido a revisión), con evidencia sintética en los partes de aplicación que requieren revisión. Primero revisa RLS y aislamientos, después corre `ANALYZE` sobre las tres tablas involucradas y usa `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` con la expresión **real** de `reviewQueueStateSql`, ordenación newest y límite 51.

Se miden 11 combinaciones: all, no_report, blocked, review, closure; all+application, no_report+application, blocked+sowing, review+harvest, closure+application y review+application. Para cada combinación y escala hay **7 mediciones reales**, con p50/p95 *nearest-rank* del `Execution Time` de PostgreSQL y duración del cliente Node incluyendo el coste de `EXPLAIN`. Se registran a través de `REVIEW_QUEUE_PG_PERF=` como JSON en logs de Actions, incluidos filas devueltas, máximo de loops, hit/read/temp buffers y tipos de nodos del plan. El output evita SQL completo, contraseñas, IDs de usuarios/tenants y cualquier dato privado.

El runner protege against pérdidas de aislamiento: verifica exactamente las filas esperadas del tenant propio, **cero** filas del tenant ajeno bajo FORCE RLS y ausencia de setting de tenant tras `COMMIT`. Limpia datos sintéticos y usuarios/tenants al finalizar. Falla si el perfil o las mediciones son incompletos; no imprime números inventados.

## Lectura correcta de los resultados

- Se trata de **tiempos PostgreSQL CI de consultas de página inicial**, no de tiempo end-to-end de HTTPS ni p95 de clientes de campo.
- `EXPLAIN ANALYZE` añade sobrecarga; la duración cliente incluye instrumentación y su varianza. Los percentiles de 7 muestras describen esa corrida, no un SLO estadístico universal.
- Los datos sintéticos tienen distribución controlada, hardware GitHub Actions compartido y caché no comparable con VPS. Debe repetirse en una réplica/escenario staging aislado para fijar presupuestos concretos.
- Observar loops elevados, scans de tablas completas, buffers y aumento de p95 al multiplicar filas permite priorizar optimizaciones respaldadas por evidencia.
- No se agregan índices/migraciones en este PR, ni se modifica SQL de producción. Si surge evidencia de plan regresivo, abrir PR separado con migración incremental, reversión segura, EXPLAIN comparables y tests de RLS, restore y cursores HMAC.
- El merge solo acredita que corre la instrumentación bajo CI/PostGIS y evita que un error silente impida obtener métricas; **no** demuestra que los costes sean aceptables para producción ni cierra automáticamente #105 hasta evaluar los resultados de runs reales.

## Ejecución / alcance

La medición corre solo en la DB PostgreSQL/PostGIS de servicio GitHub Actions ya migrada y aprovisionada. Nunca utilizar estas banderas con un servidor compartido o prod. Fuera de este alcance: staging real, backup privado+restauración real, ensayos Android/iOS/rural offline, tráfico multi-tenant real, TLS y rollback.
