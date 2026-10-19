# 0T.22 — Bandeja de revisión: estados globales con autorización y cursor firmado

## Alcance operativo
Desde 0T.21 el selector **Tipo de labor** se filtra antes del LIMIT en PostgreSQL. Con este bloque los grupos **Todas, Sin parte, Con bloqueos, Revisión humana, Posible cierre** también se consultan de manera GLOBAL al tenant autorizado. La primera página refleja hasta 50 coincidencias de toda la consulta; no se realiza `Array.filter` sobre 50 filas ya paginadas. **No se informa ningún conteo global** ni se infiere que 0 resultados en un filtro representen todas las órdenes de la empresa.

## Clasificador global, equivalencia y límites
`backend/src/modules/workOrders/reviewQueueStateSql.js` emite una expresión SQL *estática*, correlacionada con `"WorkOrder".id` y `"WorkOrder".tenant_id`, que consulta el parte seleccionado con `LEFT JOIN LATERAL`: `verified` prevalece sobre `submitted`; después, `created_at DESC, id DESC`. Evalúa en orden la falta de parte, el parte verificado, la autoría propia, el conteo de insumos frente a `input_declaration.items`, las excepciones rechazadas/pendientes, la falta de evidencia de aplicación/fertilización y la necesidad de revisión humana. La misma precedencia está definida en `classifyReviewQueueItem`; el servidor verifica **tras cargar la página** que todas las filas concuerdan con el grupo SQL, y **falla 409** ante divergencia, en vez de devolver un falso resultado.

Grupos: `all` abarca todos los estados; `no_report` solo `awaiting_report`; `blocked` incluye `self_authored`, `awaiting_inputs`, `rejected_exception`, `pending_exception`, `awaiting_evidence`; `review` contiene `human_review`; `closure` contiene `ready_for_closure`.

**Seguridad:** la expresión no admite identificadores SQL suministrados por cliente ni texto libre interpolado. Sólo introduce el UUID del usuario autenticado tras validar su formato; todo acceso a datos se ejecuta en la transacción con FORCE RLS ya vigente. Mantiene `orders.write`, rol coordinación, entitlement, multiempresa y no permite aprobar/cerrar ninguna orden.

**Rendimiento:** es un predicado SQL correlacionado que puede necesitar evaluar muchas órdenes para reunir 50 coincidencias; `LIMIT 51` limita la respuesta, NO garantiza trabajo O(51) para filtros selectivos. Antes de un piloto grande corresponde `EXPLAIN (ANALYZE, BUFFERS)` con datos representativos, evaluar índices y el costo de subconsultas. No se atribuye un benchmark inexistente.

## API y cursores
`GET /api/v1/work-orders/review-queue?type=application&state=blocked` combina filtros SQL; `all` implícito conserva respuesta anterior. No se admiten valores desconocidos, arrays, duplicados ni parámetros no permitidos (422). Cursor HMAC **v3**: `tenant/user/type/state/anchor/expiry/lastTuple` y firma con dominio v3. Reusar token de otro estado, tipo, empresa o usuario, modificarlo, vencerlo o reusar v2 da 422 con recuperación explícita. No autoriza nada por sí mismo; cada request vuelve a comprobar sesión, rol y RLS.

Keyset/ancla mantiene orden estable ante nuevas altas; estados de órdenes y partes pueden cambiar mientras se navega, por lo que **NO** es un snapshot histórico garantizado. Las aprobaciones continúan verificándose con bloqueos transaccionales en el endpoint original.

## UX
Los botones de estado son `aria-pressed` y tienen `fieldset/legend`; al elegir otro grupo se reinicia el cursor y la página y una nueva `requestKey` invalida resultados atrasados. Cambiar tipo reinicia además el estado a Todas. Navegar entre páginas o actualizar la consulta **conserva los filtros globales** y enfoca el encabezado/reintento según corresponda. La pantalla indica que los resultados siguen siendo orientativos.

## Pruebas exigidas
- Unit: precedencia, partición de ocho estados, UUID estricto, combinaciones y HMAC v3.
- PostgreSQL/PostGIS: perfil autorizador, otras empresas/roles, parámetros inválidos, clasificación `review` y `closure`, RLS, snapshot/no-falsa-aprobación.
- Chromium/Express/PostGIS: 61 inspecciones antiguas sin parte y 55 aplicaciones nuevas con parte presentado; `no_report` debe devolver inspecciones 50/11 y `blocked` aplicaciones 50/5, demostrando filtrado ANTES de LIMIT. Conservar cursor tamper, cambio de tipo, logout/tenant B, teclado/offline y cambios de estado.
- CI **exact HEAD** del PR y luego CI independiente sobre merge SHA; no confundir ambos con despliegue ni certificación física.

## Coordinación
Issue central #18; este carril ocupa solo backend workOrders/reviewState, UI/test de la bandeja y su aceptación Chromium. El otro carril puede avanzar en seguridad de sesión y issue #86 de foco, pero NO editar estos paths hasta handoff. No desplegar VPS/staging, ni modificar TOP, secretos, auth, migraciones, GPS/scouting, inventario u offline. Rollback requiere revertir cliente, servidor y cursor v3 juntos.
