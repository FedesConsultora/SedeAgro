# 0T.21 — Filtro global de tipo de labor para revisión

## Problema y frontera exacta
La bandeja anterior agrupaba **estados de revisión solo dentro de una página de 50 órdenes**, sin buscar entre el resto. Ese comportamiento sigue vigente y etiquetado como local. Este bloque añade un criterio diferente y realmente **global a la búsqueda autorizada del tenant**: el **tipo de labor** (`work_orders.type`), aplicado en PostgreSQL antes de seleccionar las siguientes 50 órdenes.

No se promete un filtro global por "sin parte", "con bloqueos", "revisión humana" o "posible cierre", porque esos estados se calculan a partir de reportes, insumos, excepciones y evidencias una vez seleccionada la página; hacerlos globales correctamente necesita otro diseño de consulta y aceptación.

## API protegida
- `GET /api/v1/work-orders/review-queue`: todo tipo (`all` implícito).
- `GET /api/v1/work-orders/review-queue?type=inspection`: órdenes de inspección de la empresa y usuario autorizados, **antes** de `LIMIT 51`; igualmente aplicación, siembra, fertilización, cosecha, riego u otras.
- `GET /api/v1/work-orders/review-queue?cursor=<opaque>&type=inspection`: segundo segmento de **ese mismo tipo**. Se rechazan tipos desconocidos, arrays/parámetros duplicados, cursor vacío y parámetros no declarados con HTTP 422.
- `type=all` explícito equivale a la opción por defecto; no hay conteos globales, ni `OFFSET`, ni valores arbitrarios.
- Requisitos intactos: autenticación/membresía activa, módulo `work_orders`, `orders.write`, rol `tenant_admin` o `agronomic_coordinator` y FORCE RLS en la base. Un cursor **jamás** es una credencial.

## Cursor HMAC v2
El cursor opaco firmado incluye `tenant, user, workType, anchor, expiry, lastDate, lastId`. La firma usa dominio `sedeagro:review-queue:v2`; caducidad de 15 minutos, máximo 1024 caracteres, comprobación de integridad constante. Reutilizarlo en otra empresa, usuario o **tipo de trabajo**, o manipularlo, produce 422. Los tokens v1 emitidos antes de actualizar quedan incompatibles; la interfaz permite iniciar una consulta nueva. La ancla y keyset estabilizan nuevas altas, **pero no inmovilizan los cambios de estado durante el recorrido**.

## UX accesible
El selector **Tipo de labor (todas las páginas)** siempre consulta al backend y es diferente de los botones **Filtrar solo esta página**. Cambiar de tipo:
1. Limpia la pila de cursores, vuelve a la primera página y reinicia el filtro local a Todas.
2. Cambia la clave de solicitud (incluye tipo) y las respuestas atrasadas no se muestran como resultados del nuevo filtro.
3. Conserva las acciones de teclado, foco al navegar, errores visibles, recuperación del cursor vencido y aislamiento por sesión/tenant.

El listado no aprueba ni cierra órdenes. Al abrir el detalle el servidor revalida permisos y estado. No se deben inferir totales por tipo ni filtrar estados de revisión globalmente.

## QA y límites de entrega
- Unit: validación de los ocho tipos, cursor firmado para cada filtro, cross-filter replay y HMAC tampering, frontera de tiempo e identidad.
- PostgreSQL/PostGIS: tipo real aplicado por backend, parámetros inválidos/duplicados 422, rol contratista 403 y aislamiento de tenant.
- Chromium + backend real: 61 inspecciones antiguas, luego 55 aplicaciones más recientes; con `type=inspection` debe seguir apareciendo una página de 50 inspecciones **aunque el top 50 sin filtro sea de aplicación**; con `type=application` páginas 50/5 y cambio de tipo en cursor => 422 real; reset al cambiar tipo y logout con segundo tenant.
- CI: verificar `tenant-rls` y `browser-offline` sobre SHA exacto del PR y SHA independiente posmerge. Fallas o reruns anteriores no se invisibilizan.

Fuera de alcance: índice o migración nuevos, filtros agregados globales por estado, counts globales, modificación de auth, RLS, inventario, aprobaciones, offline, GIS, infraestructura, despliegue, piloto y lectores de pantalla manuales. Para revertir: revertir los commits de 0T.21 de servidor, cliente y pruebas como **una unidad de contrato**, ya que v2 y URLs deben seguir coordinados.
