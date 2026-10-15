# 0T.8 — Asignación operativa verificable de órdenes

## Por qué
En `main` existía la API transaccional de responsables y el bloqueo de orden sin asignados, pero el detalle React no permitía asignar personas. Además el servidor permitía incorporar responsables a una orden ya iniciada o terminada y una membresía revocada contaba para pasar a `assigned`.

## Uso (modo Backend / live)
1. Administrador o coordinador abre **Órdenes de trabajo**, crea una orden en borrador y la envía a aprobación según el workflow existente.
2. En el detalle, **Asignar responsable** carga el directorio real del tenant; solo muestra administradores, coordinadores y contratistas con membresía y usuario activos, todavía no asignados. El botón queda deshabilitado hasta elegir uno.
3. **Asignar y notificar** hace `POST /api/v1/work-orders/:id/assignees` con `responsibility=executor`. Si el servidor confirma el `work_order_id`, el usuario y un ID de relación, se refresca el detalle desde el backend. En ausencia de confirmación, revocación o error de red no aparece éxito y se conserva la vista recuperable.
4. Una orden **approved** solo puede pasar a **assigned** con al menos un responsable cuyo usuario, membresía y rol sean aptos y sigan activos. El servidor consulta esa condición dentro de la transacción y del bloqueo de fila.
5. Al pasar a **assigned**, el grupo de responsables queda congelado para evitar nuevas asignaciones tardías; continuar con **in_progress** o **completed** sigue el flujo anterior.

## Seguridad y garantías
- `orders.write` (admin/coordinador) y entitlement `work_orders` en POST. Contratistas solo tienen `orders.execute`, no agregan usuarios. El directorio necesita `members.read` y **no** incluye miembros de otra empresa.
- Lookup del backend exige membresía activa del tenant actual, rol de destinatario permitido y usuario activo; la base conserva FKs compuestas por `(tenant_id, id)` y FORCE RLS. IDs foráneos devuelven 422/404 sin creación ni notificación.
- El bloqueo `FOR UPDATE` sobre la orden serializa asignaciones y cambios de estado de esa misma orden. Las asignaciones duplicadas antes del cierre siguen siendo idempotentes (200 replay): no generan segunda notificación ni auditoría.
- Los eventos `work_order.assignee_added` y `work_order.status_changed` se escriben en `audit_events` en la misma transacción. Registran identificadores/estados y actor, **no** instrucciones, notas libres, ubicación ni contenido de evidencia. `x-request-id` no UUID se representa como NULL, sin fallar la escritura.
- El selector de navegador **no** otorga permisos: el backend sigue rechazando 403/404/409/422 cuando cambien estado o membresía concurrentemente. Los formularios mock no envían escrituras.

## Pruebas exigidas
- `npm --workspace backend run test`: estados asignables, elegibilidad, request ID y guardias de ruta.
- `npm --workspace frontend run test`, `npm --workspace frontend run build`: filtro de miembros, privilegios de UI, confirmación API y wiring del drawer.
- `npm --workspace backend run test:db` en PostgreSQL/PostGIS **desechable** con `TEST_DATABASE_ADMIN_URL` y `TEST_DATABASE_APP_URL`: tenant A/B, revocación, RLS, 403 al contratista, 404 tenant extranjero, 409 en orden congelada, replay/no duplicación, auditoría y rollback, incluidos tests tras restore.
- CI debe acreditar checkout y jobs sobre HEAD exacto del PR y nuevo HEAD de main. Tests reales que falten deben indicarse NOT_RUN.

## Límites explícitos y siguiente bloque
- Esto **no certifica ejecución física**. El estado `completed` existente aún es una declaración de estado sin acta de labores, medidas reales ni evidencias obligatorias; debe abordarse aparte antes de aceptación de campo.
- No permite reemplazar o retirar responsables tras congelar asignaciones. El procedimiento actual consiste en cancelar una orden no terminal y emitir otra, conservando trazabilidad del cambio.
- No incluye aceptación móvil real en Safari/iOS/Android, redes rurales, ni deploy de VPS. Sin sincronización offline de órdenes.

## Reversión
No hay migración nueva. Antes de revertir, confirmar si hay operaciones en curso y conservar los `audit_events` ya escritos. Revertir mediante un nuevo PR los cambios acotados de backend, frontend y tests, y ejecutar suite de permisos, integración PostgreSQL y build sobre el SHA de reversión. Un rollback del código no debería borrar los responsables ni sus auditorías.
