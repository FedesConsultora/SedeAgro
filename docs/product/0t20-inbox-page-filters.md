# 0T.20 — Filtros por tipo de pendiente, limitados a una página autorizada

## Necesidad
La bandeja 0T.15–0T.18 permite a coordinación navegar de manera segura por páginas de 50 órdenes con cursor HMAC. Sin embargo, todos los estados se presentan juntos y cuesta localizar casos sin parte, bloqueos de documentación o posibles cierres. Este bloque incorpora **clasificación visual en la página ya recibida**, sin cambiar ni ampliar el endpoint.

## Contrato de producto
- Los botones **Todas**, **Sin parte**, **Con bloqueos**, **Revisión humana** y **Posible cierre** usan únicamente `state` calculado por el backend. No infieren estado de datos no autorizados.
- `Sin parte` = `awaiting_report`; `Con bloqueos` = `self_authored`, `awaiting_inputs`, `rejected_exception`, `pending_exception`, `awaiting_evidence`; `Revisión humana` = `human_review`; `Posible cierre` = `ready_for_closure`.
- El filtro **solo afecta los resultados de la página actual**, máximo 50. No busca en todo el tenant; no calcula totales globales; no ordena ni altera cursores, sesiones, estados, reportes o inventario.
- El contador **N de M órdenes visibles en esta página** es exclusivamente local. Si el filtro tiene cero coincidencias, se explica que puede haber resultados en otras páginas. Los botones de página anterior y siguiente mantienen su estado derivado del backend y no del filtro.
- Cambiar de página o **Actualizar pendientes** vuelve automáticamente a **Todas**. Cambiar usuario/tenant/rol/modo o la revisión del workspace desmonta la bandeja, cancelando los requests previos. El detalle reconsulta autorización y datos frescos.
- El control es un fieldset con leyenda, botones `aria-pressed`, foco visible y objetivos táctiles de al menos 44 px; no aprueba ni cierra una orden.

## Verificación y regresiones
- Tests unitarios: cobertura exacta de los ocho estados del servidor, no mutación de la página, respuesta vacía y rechazo de filtros desconocidos.
- Tests de componente por contrato: controles, conteo solo de página, reset por navegación y refresh, sin suplantar el endpoint del servidor.
- Chromium + Express + PostgreSQL/PostGIS reales: primera página de 50 órdenes, filtro sin coincidencias y Next disponible, grupo Sin parte con 50, reset en página 2 (11), actualización explícita que recupera primera página, cursor firmado y aislamiento entre tenants existentes.
- Gate de GitHub Actions previo y posmerge: revisar **HEAD exacto**, `tenant-rls` y `browser-offline`. Los resultados solo son PASS si el log corresponde al SHA verificado; no convertir reruns o fallos previos en un éxito retroactivo.

## Límites y rollback
No se agrega filtro global ni búsqueda por toda la base: requeriría un endpoint paginado propio y un cursor vinculado a ese criterio, con índices y permisos reevaluados. El servidor sigue siendo autoridad de RLS, cierre y revisión. No hay cambio en auth, RLS, API, migraciones, offline, GIS, notificaciones, entorno productivo ni inventario. No representa QA manual WCAG/VoiceOver/TalkBack ni aceptación de campo.

Rollback independiente: revertir los cuatro commits del PR de 0T.20; los contratos 0T.19 y previos permanecen intactos.
