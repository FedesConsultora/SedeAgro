# Matriz de autorización de SedeAgro — Bloque 0B

**Estado:** aplicada a los endpoints de negocio en backend. La autorización se comprueba en el servidor, independientemente de lo que muestre la UI.

## Invariantes de acceso

1. El usuario debe enviar un JWT válido; `requireAuth` comprueba su membresía activa en el tenant resuelto.
2. `requireCapability` valida que el rol de la membresía coincida con el rol cargado y que el actor y el tenant coincidan con la sesión.
3. El entitlement del módulo **no reemplaza** al permiso de acción. El acceso se evalúa como autenticación + tenant + entitlement (si corresponde) + capability.
4. `tenant_admin` tiene todos los capabilities dentro de su propio tenant. Un `platform_admin` no obtiene capacidades de empresa por ser administrador global.
5. Roles desconocidos, suspendidos, o no coincidentes se rechazan por defecto (HTTP 403).
6. Los permisos se definen por ahora en `src/infra/http/middlewares/requireCapability.js`. Las tablas `permissions` y `role_permissions` existentes **no** alimentan aún este middleware; no cambiar permisos en base de datos esperando que autoricen una ruta.
7. La protección RLS existente debe validarse con PostgreSQL y dos tenants reales antes de un piloto.

## Matriz de acceso por rol

| Área | Admin tenant | Coordinador agronómico | Monitoreador | Contratista | Productor |
| --- | --- | --- | --- | --- | --- |
| Miembros (directorio) | Leer | Leer | No | No | No |
| GIS / lotes | Leer/escribir | Leer/escribir | Leer solo lotes de recorridas asignadas | No | Leer solo productores, establecimientos y lotes autorizados |
| Lluvia y riego | Registrar | Registrar | Registrar solo en lotes de recorridas asignadas | No | No |
| Campañas | Leer/escribir | Leer/escribir | Leer solo campañas y lotes de recorridas asignadas | No | No |
| Recorridas | Planificar/leer | Planificar/leer | Leer únicamente las asignadas; observar, iniciar y completar sus propias recorridas | No | No |
| Órdenes de trabajo | Crear/aprobar/ejecutar | Crear/aprobar/ejecutar | No | Ver y ejecutar **solo las asignadas** | No |
| Equipos / activos | Leer/escribir | Leer/escribir | No | No | No |
| Imagery | Leer/escribir (si habilitado) | Leer/escribir (si habilitado) | No | No | No |
| Reportes | Leer/solicitar | Leer/solicitar | No | No | No |
| Sync | Ver/enviar | Ver/enviar | Solo enviar | No | No |
| Notificaciones personales | Propias | Propias | Propias | Propias | Propias |

**Alcance actualizado (Bloque 0E):** `producer_viewer` puede consultar GIS únicamente para los productores otorgados mediante `producer_access_grants` (y sus establecimientos/lotes). Las concesiones las crea y revoca `tenant_admin`; ver [guía del modelo](producer-access-grants.md). Campañas, reportes, observaciones y demás operaciones continúan denegadas. No hay grants independientes por lote ni asesor externo.

## Flujo protegido de órdenes

```text
draft → pending_approval → approved → assigned → in_progress → completed
          ↓               (si existe un responsable activo)
         draft
```

Una orden no se puede crear en estado distinto de `draft`. El administrador de empresa o coordinador puede transicionar por las aristas permitidas y cancelar órdenes no terminales. El contratista solo puede pasar `assigned → in_progress → completed` si tiene una asignación vinculada al tenant activo. Una orden en `completed` o `cancelled` es terminal.

Se utiliza un bloqueo de escritura de fila al cambiar estado para serializar las transiciones. No hay todavía firmas de aprobación ni bitácora de transiciones: el campo `approved_at` existente no sustituye una auditoría formal.

## Pruebas y límites

- Pruebas unitarias del mapeo rol/capability, rechazo de otros tenants, transiciones y contratistas.
- Prueba estática de 57 rutas de negocio: toda ruta debe declarar un `requireCapability` explícito.
- Regresión sobre consulta de notificaciones personales y directorio de miembros.
- **Integrado:** gate de PostgreSQL/PostGIS RLS para tenants A/B, con pruebas de concesión y revocación de productor. Aún falta ejecutar pruebas en el VPS y una auditoría completa antes del piloto.
- **Pendiente de UX:** adaptar controles del frontend a los capabilities server-side y separar claramente el modo mock del modo real.
- **Bloque 0G:** el monitoreador ve GIS/campañas y registra agua solo para lotes derivados de sus recorridas asignadas. Ver [modelo de asignaciones](../scouting-assignments-field-scope.md). Continúan pendientes alcance granular de asesores externos, catálogos y operaciones de sincronización.
