# 0T.14 — Aceptación integrada de órdenes y revisión visible de excepciones

## Base auditada
`main` exacto `dbd6471b32373592611ab1de86c5bf6bad275f15`: 0T.8 responsables, 0T.9 partes y revisor independiente, 0T.10 adjuntos privados, 0T.11 checklist y SHA, 0T.12 cantidades planificadas vs declaradas, 0T.13 excepciones por insumo no previsto. Este bloque **no reimplementa contratos ni cambia migraciones/roles**. Issue #86 documenta que el gate Chromium de `scripts/acceptance-browser-cookie.mjs:99` falló al hacer Shift+Tab sobre un formulario cuyo botón Crear todavía podía estar deshabilitado por el lookup asíncrono de productores.

## Mejora de producto: aprobación de partes con información remota verificada
Antes de habilitar **Aceptar revisión**, el componente de órdenes consulta la respuesta **real** y autorizada de `GET /work-orders/:id/execution-exceptions`. Una lectura pendiente, fallida o que corresponda a otro ID de orden/conjunto de partes deja la aprobación **deshabilitada** y presenta un motivo comprensible.

Una vez confirmada la lista, la UI solo permite pulsar la aprobación si ninguna excepción del parte está pendiente ni rechazada. Un reporte antiguo rechazado conserva su historia pero **no bloquea** la nueva presentación revisable. Si hay un rechazo del parte, los botones para rechazar y comenzar un parte nuevo se mantienen disponibles según los permisos ya existentes. Ningún elemento de la UI concede autorización, modifica la declaración original o inventa éxito: el endpoint de revisión sigue releyendo dentro de su transacción todos los insumos, checklist, archivos íntegros y excepciones y puede devolver 403/404/409 bajo concurrencia, cambios de membresía o estados.

Se corrige además un estado vacío engañoso: una consulta fallida de excepciones **no** se representa como «Sin insumos no previstos». Se ofrece reintento explícito. El estado de readiness está asociado a `order.id` y a una firma estable de IDs de partes en el detalle; no se reutiliza una lectura de otra orden ni de una versión distinta del historial.

## Prueba integrada PostgreSQL/PostGIS (dos tenants)
`backend/test/assignmentNotifications.pg.mjs` extiende el flujo de rechazo del 0T.13 hasta el final, con solicitudes HTTP autenticadas reales:
1. Un contratista presenta parte + insumo no previsto.
2. Coordinación rechaza la excepción; la aprobación del parte se deniega (409).
3. Coordinación rechaza el parte con motivo y se intenta añadir tardíamente a la versión rechazada: 409.
4. El mismo autor presenta **otro parte** con nuevo ID sin sobrescribir el anterior; declara nuevamente el insumo con otra cantidad y motivo.
5. Dos reintentos concurrentes del **mismo UUID** retornan el mismo recurso sin crear duplicados ni auditorías extra.
6. Se deniega la aceptación mientras el nuevo insumo sigue pendiente; un administrador distinto aprueba esa excepción.
7. Un coordinador diferente del autor verifica el nuevo parte con checklist y completa administrativamente la orden.
8. Se reconsulta el historial privado: el parte y la excepción anteriores siguen **rejected**, el nuevo parte está **verified** y su excepción **approved**, sin acceso del tenant B a esos datos.

Este gate no demuestra movimiento físico de materiales, prescripciones agronómicas, validación profesional, mediciones ni descontar inventario.

## Estabilidad de accesibilidad — issue #86
La prueba real de teclado y foco del modal Nuevo establecimiento ahora **espera una condición funcional observable**: que su botón Crear termine de habilitarse tras consultar productores. Solo después de esa condición exige que el diálogo conserve el foco, que Shift+Tab llegue al último control, Tab vuelva al primero, Escape cierre y que el foco regrese al disparador. No usa delays arbitrarios, sleeps, reintentos de aserciones ni elimina los requisitos de accesibilidad. Si la UI deja de cumplir el contrato, el test continúa fallando.

## Entrega, verificación y límites
- **Rutas tocadas**: `frontend/src/services/executionReviewReadiness.js`, `frontend/src/components/WorkOrderExecutionPanel.jsx`, `frontend/src/components/WorkOrderExecutionExceptions.jsx`, tests de frontend, `backend/test/assignmentNotifications.pg.mjs`, `scripts/acceptance-browser-cookie.mjs` y este documento.
- CI exact-HEAD: backend/frontend unit, build React, integración PostgreSQL/PostGIS, FORCE RLS, backup→restore con regresión, Chromium real y browser/offline. Después de merge se reejecutan checks sobre el merge SHA.
- Sigue pendiente **aceptación física de campo** y verificación manual en dispositivos/navegadores representativos, redes rurales, errores de radio, accesibilidad auditiva y permisos/UX en uso real. Tampoco se modificaron inventario, autenticación, GIS, scouting, reportes, CI, VPS ni producción.
- No se considera el cliente como fuente de verdad y no se usan ejemplos/mock cuando el backend no responde.
