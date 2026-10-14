# Bloque 0E — Visibilidad explícita de productores y módulos RLS

## Alcance de seguridad

SedeAgro separa dos controles independientes:

1. **Empresa/tenant:** `tenant_id` se impone con transacciones, validación de membresía y RLS.
2. **Recurso/establecimiento:** un usuario con rol `producer_viewer` solo ve productores a los que se lo vinculó expresamente. Sus establecimientos y lotes se derivan de esos productores.

No se concede acceso por coincidencia de nombre, correo, contacto ni pertenencia general a una empresa. Un productor sin concesiones recibe colecciones vacías y respuestas 404 cuando intenta consultar recursos individuales. Los permisos `gis.write`, `reports.read` y otros módulos siguen denegados al productor.

## Modelo de datos

Migración `202610140002_producer_access_and_tenant_modules_rls.js` crea `producer_access_grants` con `tenant_id`, `user_id`, `producer_id`, `granted_by` y sellos de tiempo.

- La clave única `(tenant_id, user_id, producer_id)` impide duplicados.
- FK compuestas evitan vincular un usuario o productor de otra empresa. Eliminar membresía o productor elimina sus concesiones.
- `FORCE ROW LEVEL SECURITY` protege la tabla y limita sus filas al tenant de la transacción.
- Se habilita además RLS forzado en `tenant_modules`, la tabla de entitlements de cada empresa. Las consultas públicas a módulos en registro/login ya se ejecutan bajo el contexto del tenant seleccionado; los administradores de plataforma utilizan un cambio de contexto SQL temporal dentro de la misma transacción.

`memberships` queda fuera de RLS porque el login puede requerir seleccionar entre distintas empresas del mismo usuario; no se considera aún cerrada la separación total de identidades globales. Este bloque no aplica automáticamente permisos internos por lote para monitoreadores.

## API

Solo el **administrador del tenant** tiene permiso `producer_access.manage` por ser `tenant_admin`. Los endpoints requieren JWT válido, tenant activo, módulo `gis` habilitado y autorización de recurso:

| Método | Ruta | Resultado |
| --- | --- | --- |
| GET | `/api/v1/farms/producers/:producerId/access` | Lista de concesiones del productor |
| POST | `/api/v1/farms/producers/:producerId/access` | Crea concesión; body `{ "user_id": "UUID" }` |
| DELETE | `/api/v1/farms/producers/:producerId/access/:userId` | Revoca concesión, 204 |
| GET | `/api/v1/farms/producers` | Productor: solo IDs y nombres autorizados |
| GET | `/api/v1/farms`, `/api/v1/farms/:id` | Solo establecimientos del productor concedido |
| GET | `/api/v1/fields`, `/api/v1/fields/:id` | Solo lotes de establecimientos concedidos |

El alta valida que el usuario tenga membresía **activa**, rol `producer_viewer` y pertenezca al mismo tenant. El alta duplicada devuelve 200 sin crear una nueva concesión. La revocación surte efecto en la próxima consulta, sin cambiar ni reemitir el JWT.

## Administración de plataforma

Las operaciones sobre `/api/v1/platform/tenants/:id/modules` requieren administrador global y comprueban que el tenant objetivo exista. El backend activa temporalmente su contexto RLS **en la transacción actual** y lo restaura antes de responder. No se crean transacciones independientes que puedan confirmar operaciones a espaldas del middleware HTTP.

También se alinearon los valores del backend con los CHECK SQL existentes:

- Origen de módulo manual: `override` (antes se intentaba `platform`, valor inválido).
- Estado de tenant: `deleted` en lugar de `archived`.

## Pruebas de integración

`npm --workspace backend run test:db` (solo base PostgreSQL/PostGIS desechable) comprende:

- Validación de **29 tablas RLS**: las 27 previamente cubiertas + `tenant_modules` + `producer_access_grants`.
- Registro, login y lectura de perfil con los entitlements correctos.
- Productor sin concesiones, concesión, duplicación, listado restringido, IDOR por lote/establecimiento, revocación y cambio de tenant con JWT del tenant original.
- Administración de plataforma con módulos habilitados/deshabilitados en otro tenant; rechazo de operadores sin privilegios; confirmación de que el contexto SQL del tenant emisor no queda alterado.

## Pendientes y precauciones

- Migración y backup del VPS deben realizarse según `docs/security/postgres-rls-runbook.md`; **ningún despliegue a producción ocurre por integrar este PR**.
- El acceso del productor es inicialmente de **lectura GIS limitada**; no incluye reportes, campañas, observaciones, imágenes satelitales ni órdenes.
- Los grants se administran por API. No se agrega todavía UI para asignar productores o quitar permisos.
- `memberships` sigue requiriendo arquitectura de autenticación global separada de las operaciones por tenant.
- Es necesario verificar en CI y VPS la continuidad del login y el usuario PostgreSQL no privilegiado tras habilitar RLS de `tenant_modules`.
