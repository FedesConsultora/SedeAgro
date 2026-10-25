# Piloto — Alta de lote con acuse de identidad confirmado

**Alcance:** Establecimientos → Nuevo lote (`POST /api/v1/fields`), coordinación #18, aceptación #166. Base original `main@4d76122d8e1c7753b3ca7226d51a60da77395f2c`. Entorno productivo #130 **NO-GO**.

## Incidencia observada en el código anterior

- `FieldFormModal` sólo usaba estado React `saving` contra doble toque; un segundo submit previo al render podía crear dos lotes distintos.
- El formulario ejecutaba `onCreated()` al recibir cualquier promesa resuelta, sin comprobar UUID, tenant, establecimiento, nombre, hectáreas ni estado de la fila devuelta.
- `Number(form.area_hectares) || 0` convertía errores de superficie a cero y admitía silenciosamente redondeos distintos de DECIMAL(12,2).
- La lista asíncrona de establecimientos y el formulario no estaban asociados al actor/empresa/API de la sesión actual. Un GET tardío podía persistir opciones de una identidad anterior hasta limpiarlas mediante efecto.
- La ruta demo podía llamar `onCreated` sin persistir el lote.

## Implementado

1. `fieldCreateScope` exige sesión live autenticada, usuario/tenant, rol `tenant_admin` o `agronomic_coordinator`, entitlement GIS y establecimiento preseleccionado UUID válido. **No sustituye al backend `gis.write` ni FORCE RLS.**
2. Selector de establecimientos y formulario se conservan en snapshots `scope+api`, ocultos desde el propio render cuando cambian los permisos/identidad. Errores de GET deshabilitan guardar y habilitan un reintento manual, sin datos demo.
3. `prepareFieldCreate` verifica establecimiento, nombre, estado, superficie no negativa con hasta dos decimales y rango DECIMAL(12,2); conserva superficie cero legítima. Notas vacías se omiten y las no vacías se recortan.
4. Ticket síncrono antes del primer `await api.createField`: bloquea dobles envíos. X, Escape, overlay y Cancelar quedan temporalmente sin efecto mientras el POST está pendiente. Cualquier fallo posterior al envío se trata como ACK incierto y no reenvía automáticamente.
5. `verifyCreatedField` sólo confirma UUID válido, tenant exacto, establecimiento, nombre, superficie, estado y notas originales. Si la respuesta 2xx no coincide, se debe comprobar el listado antes de intentar otro POST.
6. Demo no declara que el backend haya creado un lote.

## Pruebas y aceptación

`frontend/test/fieldCreateSafety.test.js` cubre role/tenant/actor/entitlement, cambio de establecimiento, catálogo de otra empresa, superficie decimal inválida/no redondeable, notas opcionales, acuses falsos, doble submit asíncrono, resultado incierto, tickets obsoletos y wiring del modal.

**Manual pendiente:** crear lotes con y sin selección previa de establecimiento, comprobar UUID y `farm_id` con cuenta autorizada en PostgreSQL FORCE RLS, simular pérdida del acuse después del COMMIT, doble toque en Android/iOS reales, rotación de empresa durante GET/POST y validar superficies 0, 82.50 y error por 2.555. Staging y móviles físicos: **NOT_RUN**.

**Limitación:** el servidor `POST /fields` no admite clave de idempotencia persistente. El cliente protege una apertura del modal, pero refresh/otra pestaña/dispositivo pueden crear duplicados. No imponer unicidad por nombre de lote: dos lotes legítimos pueden compartir nombre. Debe abordarse como trabajo separado si el piloto exige replay duradero.

No se modifican backend, DB, roles, geometrías GIS, sesión, cola offline, CI ni infraestructura. No es certificación de release por sí sola.
