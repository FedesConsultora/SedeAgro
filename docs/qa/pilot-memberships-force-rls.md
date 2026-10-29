# P0 #232 — Membresías bajo FORCE RLS sin romper el selector multiempresa

**Fecha:** 29/10/2026. **Estado:** candidato a aceptación; NO certifica staging ni release.

## Hallazgo y alcance

Antes de este bloque, `memberships` permitía que el rol de aplicación leyera cualquier tenant si omitía `tenant_id`, aunque los endpoints autorizados acotaban sus consultas. La causa principal de esa excepción era `POST /auth/login`: una vez verificada contraseña y cuenta global activa, usaba un `Membership.findAll({user_id, status:'active'})` *sin un tenant seleccionado* para mostrar empresas disponibles. Habilitar FORCE RLS sobre esa consulta habría roto el inicio de sesión de una cuenta presente en varias empresas.

No se ha demostrado una explotación remota; sí había ausencia de defensa en profundidad frente a consultas SQL accidentales o futuras.

## Solución aplicada

1. Migración `202610290002_memberships_force_rls.js`: habilita y **fuerza** RLS en `public.memberships`, política `tenant_id = app.current_tenant_id()` para SELECT/UPDATE/INSERT/DELETE, con chequeo WITH CHECK al escribir. Sin tenant GUC, cero filas visibles y ningún UPDATE/DELETE posible. RLS sigue siendo defensa frente a errores de consulta; el backend mantiene RBAC, cookies HttpOnly y transacciones.
2. `loginMembershipDiscovery.js`: consulta `tenants` (catálogo global de ID/nombre/slug/estado). **Sólo después de la verificación de contraseña y estado global**, por cada empresa candidata instala su GUC mediante `setLocalTenant` dentro de una única transacción y lee **una** membresía activa de ese usuario con `tenant_id` explícito. No usa roles especiales, funciones `SECURITY DEFINER`, vistas desprotegidas ni bypass de la tabla.
3. Solicitudes con `tenantId` o `tenantSlug` filtran directamente una empresa candidata y conservan los controles de coincidencia exacta de ambos selectores. Sin selector, el listado está acotado a **250 empresas activas/onboarding**: si supera ese tamaño falla con 503 `LOGIN_DISCOVERY_CAPACITY_LIMIT`, **sin** filtrar arbitrariamente empresas del usuario ni degradar la política. Este límite es deliberado para un primer piloto, NO es diseño escalable de un SaaS con miles de empresas.
4. `issueTenantSession` no cambia: antes de emitir JWT/JTI hace `SELECT FOR UPDATE` de la empresa, la membresía exacta y el usuario con comprobación de estado; el módulo entitlement se vuelve a leer bajo el tenant y el límite de sesiones sigue activo.
5. Registro de empresa crea su membresía bajo `setLocalTenant`; invitación y activación usan `withTenantTransaction`; `requireAuth`, Team, la administración local y las FK tenant compuestas siguen acotadas. No se cambia el acceso de plataforma, que gestiona sesiones globales mediante tenant local temporal.

## Evidencia de seguridad y regresión

- `backend/test/membershipForceRls.pg.mjs`: PostgreSQL real con rol de aplicación sin superusuario, owner o BYPASSRLS; exige `relrowsecurity` y `relforcerowsecurity`, no GUC implica cero lectura y cero mutación; tenant A no ve ni actualiza B; GUC transaccional se revierte; login con dos empresas, selector exacto, contraseña incorrecta y membresía bloqueada.
- `backend/test/loginMembershipRecheck.pg.mjs` y `loginTenantStatusRace.pg.mjs`: mantienen inyección determinística de cambios entre descubrimiento y creación de sesión, ahora instrumentando `Membership.findOne` dentro del alcance RLS; no se puede emitir JWT después de suspensión o bloqueo.
- `backend/test/loginMembershipDiscovery.test.js`: barreras de cantidad, no lectura global, scopes explícitos y sesión revalidada.
- Resto de `test:db` CI: registro, invitaciones, membresías, plataforma, aislamiento, equipos, formularios y operaciones agrícolas no deben perder capacidades.
- CI de PR requiere 5/5 sobre SHA exacto; CI independiente de main requiere 7/7, incluido bundle OCI firmado e importación con verificación de capas.

## Limitaciones y decisión de release

El scan de tenants sin selector tiene complejidad O(N) lecturas bajo transacción y límite de 250 empresas; medir latencia p50/p95 con fixtures de 1, 25, 100 y 250 tenants antes de habilitar escala. En una etapa futura, diseñar una proyección indexada de descubrimiento mínimo, revisada por seguridad, que no otorgue lectura de todas las membresías a un rol runtime. Evitar `SECURITY DEFINER` no garantiza por sí solo seguridad: revisar grants, funciones y capacidad de cambiar GUC dentro del rol de aplicación.

Rollback de migración revierte RLS y por tanto debilita el aislamiento: ejecutar **sólo** en base disposable o con autorización formal de seguridad y recuperación aprobada. Registrar evidencia de upgrade/rollback en staging aislada con representante de seguridad.

**No GO**: No se ha realizado revisión externa de seguridad, prueba de migración con copia anonimizada, staging productiva ni aceptación de dispositivos. Issues #130, #163 y #166 continúan. Este bloque no despliega a VPS ni modifica secretos.
