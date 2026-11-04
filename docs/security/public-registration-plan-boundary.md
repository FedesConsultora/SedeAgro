# SedeAgro 0.1 — Registro público: límite de plan y permisos

**Bloque 0R.12 · 2026-11-04 · Coordinación #18 · Release #130: NO-GO**

## Hallazgo verificado

`POST /api/v1/auth/register-tenant` es una operación **pública**; inicialmente su esquema permitía `planCode` de texto libre, y el backend buscaba `Plan.findOne({code: payload.planCode,is_active:true})`. El catálogo seed inicial sólo registra `starter`, pero el modelo admite múltiples planes activos y la plataforma autoriza cambios de `plan_id` mediante `PATCH /platform/tenants/:id` a un administrador global.

Si en el futuro se agrega un plan superior activo, un cliente podría registrar un tenant seleccionando directamente su código sin autorización de facturación/plataforma. Ese plan se usaría para poblar `tenant_modules` de la nueva empresa. Es una **falta de separación de autoridad en código**, no una explotación real confirmada ni una afirmación de que existe hoy un catálogo premium comercializado.

## Contrato implementado

1. El único plan elegible por registro público es **`starter`**, activo en el catálogo. El cliente puede omitir `planCode` o especificar literalmente `starter` para compatibilidad; cualquier otro valor se rechaza en el esquema antes de cualquier escritura de usuario/tenant/sesión.
2. El query servidor selecciona explícitamente `code:'starter', is_active:true` independientemente del cuerpo enviado. Un plan `starter` desactivado continúa rechazándose, no se improvisa fallback a otro plan.
3. La **administración de plataforma** mantiene la facultad separada de cambiar `plan_id` en un tenant existente después de una autenticación y la auditoría correspondiente. No se crea endpoint de upgrade público, bypass de pago, token especial ni nuevo rol.
4. El registro existente de usuario, membresía admin, `TenantModule`, cookies y sesión bajo transacción/RLS se mantiene sin cambios para el plan permitido.

## Pruebas

- `backend/test/authRls.pg.mjs` usa PostgreSQL desechable y un backend HTTP real conectado como rol sin bypass RLS. El dueño del fixture crea un plan **premium activo** con `integrations`, luego intenta registrar otra empresa con ese `planCode`: exige HTTP 422, sin token/cookie, sin nuevo usuario, tenant ni sesión. La limpieza borra el plan y cualquier registro inesperado. Continúa el alta legítima sin `planCode` con cookie/entitlements y las pruebas de autenticación/revocación existentes.
- `backend/test/publicRegistrationPlanContract.test.js` protege que la ruta pública no reintroduzca un selector de plan arbitrario y que la modificación de plan siga detrás del middleware de administrador global.
- Verificar CI exact HEAD de PR y, tras merge normal, CI independiente de main. No atribuir PASS de staging o dispositivos a CI.

## Alcance y despliegue

Sin cambio de esquema, planes existentes, suscripciones, usuarios reales, cuotas, política RLS, migraciones ni permisos de roles. La plataforma conserva la gestión explícita de planes. No se ejecuta staging, producción, billing ni conexión a proveedores.

**Release #130 permanece NO-GO** hasta pruebas físicas Android/iOS, restauración y rollback en entorno autorizado, auditoría externa de seguridad, benchmark de staging y aprobaciones humanas. El código no puede fabricar esas pruebas.
