# SedeAgro 0.1 — medición real de descubrimiento multiempresa bajo FORCE RLS

**Bloque 0R.13 — 10/11/2026 · Issue #232 · Release #130: NO-GO.**

## Qué mide

`loginMembershipDiscovery.js` usa una transacción PostgreSQL con GUC local por tenant y búsqueda exacta de membresía activa bajo `ENABLE + FORCE RLS`. Esta propiedad está probada en tests de seguridad, pero su coste sin selector crece con cada tenant activo del catálogo global. El límite de producción en código es **250**; 251+ falla 503, salvo búsqueda con selector explícito de empresa.

El nuevo `scripts/benchmark-login-membership-discovery.mjs` mide en base **real** `sedeagro_test` PostgreSQL/PostGIS migrada, conectada como rol de aplicación **distinto del propietario y sin BYPASSRLS**. Crea un usuario sintético con una sola membresía activa y va agregando empresas hasta exactamente **1, 25, 100 y 250**. En cada escala toma dos calentamientos y **siete muestras cronometradas** de:

- Descubrimiento **sin selector** (`discoverLoginMemberships(userId)`): escanea los N tenants dentro de una transacción local acotada.
- Descubrimiento con **`tenantId` exacto**: filtra 1 empresa y verifica acceso.
- Descubrimiento con **`tenantSlug` exacto**: filtra 1 empresa y verifica acceso.

Cada invocación exige exactamente la membresía autorizada y ninguna otra. Además, el rol runtime sin GUC debe leer **cero filas** de `memberships`; se verifican `relrowsecurity` y `relforcerowsecurity` en DB real. Al agregar la empresa 251, se comprueba que la consulta sin selector responde con `LOGIN_DISCOVERY_CAPACITY_LIMIT` y que un selector explícito sigue encontrando la membresía.

Las muestras se informan en `LOGIN_MEMBERSHIP_RLS_PERF` como p50/p95 de latencia de búsqueda (ms); **no incluyen hashing de contraseña, red HTTP, despliegue ni TLS**. Registra entorno y versión PostgreSQL en `LOGIN_MEMBERSHIP_RLS_ENV`, pero nunca UUID, nombres, email, password, URL DB, SQL ni datos privados. No se compara con un SLO inventado: las cifras son observaciones del runner GitHub descartable, no cotas de staging.

## Seguridad del ensayo

La ejecución exige **simultáneamente** `CI=true`, `GITHUB_ACTIONS=true`, `SEDEAGRO_LOGIN_PERF_PROBE=I_ACCEPT_ONLY_DISPOSABLE_MEMBERSHIP_RLS_BENCHMARK`, dos URL PostgreSQL en el **mismo host loopback y misma BD *_test** y usuarios owner/runtime diferentes. Comprueba además la identidad real de la DB y rol no privilegiado antes de escribir. Rechaza datos previos de tenants activos y nunca opera contra VPS, staging ni producción. Los 251 tenants sintéticos se eliminan en `finally`; el usuario también.

El CI principal ejecuta el benchmark **después de migrar, aprovisionar runtime y completar `test:db`**, evitando confundir una base no preparada con una medición. El test unitario valida estrictamente la bandera de entorno, URLs, percentiles y barreras de privacidad. Si hay fallos de conexión, fixtures, métricas, aislamiento o limpieza, el job falla.

## Aceptación restante

Con las cifras de CI disponibles, Security/Operations deben acordar el p95 admisible y medir **login HTTP real** (incluyendo verificación de contraseña, DB, proxy y TLS) en un **staging privado autorizado**, con 1/25/100/250 empresas y datos ficticios. Revisar el diseño de catálogo global y grants, migración/rollback de memberships FORCE RLS y riesgo de enumeración tras autenticación. Esta PR **no cambia permisos, código de login ni límites**, no autoriza el despliegue y no certifica rendimiento de producción.

Los casos físicos MOB y la firma de release en #130/#166 continúan independientes.
