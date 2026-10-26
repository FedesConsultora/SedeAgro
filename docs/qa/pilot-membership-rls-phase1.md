# SedeAgro 0.1 — Fase 1 del bloqueo #232: sesión ligada a membresía vigente

Base revisada: `main@33468f0078efdba0703280b490aea1704b7b4bbb`. **La tabla `memberships` todavía NO tiene ENABLE/FORCE RLS.** No se añade una migración de seguridad incompleta ni se certifica #232.

## Hallazgos de riesgo confirmado en código

1. El login valida contraseña y `users.status === active`; luego obtiene las membresías activas con `Membership.findAll` **antes de abrir la transacción** que emite la sesión. Un administrador podría suspender o cambiar el rol entre el primer SELECT y el INSERT de `auth_sessions`.
2. El antiguo selector `tenantId || tenantSlug` comparaba `membership.tenant_id === tenantId || Tenant.slug === tenantSlug`. Si ambos identificadores eran contradictorios podía elegirse una empresa diferente de la intención del cliente, aunque ya autenticado.
3. Registro público de empresa creaba `Membership` antes de fijar `app.current_tenant`; esto bloquearía una futura adopción de FORCE RLS sobre esa tabla.

## Contrato aplicado

- El login público sólo enumera empresas después de verificar contraseña y estado global. Ambos selectores —si se enviaron— deben coincidir en la **misma** membresía autorizada. Empresa inexistente, ajena o par ID/slug incoherente recibe `403 LOGIN_TENANT_NOT_AVAILABLE`, sin emitir sesión ni volver a mostrar el listado.
- `issueTenantSession` relee `Membership` mediante `SELECT FOR UPDATE` dentro de una transacción con `app.current_tenant`, con filtros explícitos `id + tenant_id + user_id + status=active`. Si la membresía cambió o fue suspendida, responde `401 LOGIN_MEMBERSHIP_CHANGED`, no crea JWT ni `auth_sessions`.
- El JWT y el recibo de sesión usan **el rol y los datos revalidados bajo lock**. La selección inicial nunca es autoridad para emitir un token; el middleware `requireAuth` sigue comprobando pertenencia y rol en cada solicitud.
- `register-tenant` instala el GUC del tenant creado **antes** de crear la membresía administradora, dentro de la transacción que también activa los módulos bajo FORCE RLS.

## QA reproducible

- `backend/test/loginMembershipPolicy.test.js` verifica selección por par, rechazo de identificadores contradictorios, orden de GUC y de lock antes de emitir JWT.
- `backend/test/loginMembershipRecheck.pg.mjs` prueba HTTP real sobre PostGIS desechable con runtime non-owner. Inicia sesión en dos empresas, verifica selección, transporte cookie, y utiliza una intervención determinista del método `Membership.findAll` para suspender una membresía *después* de la lectura pública y *antes* de la relectura transaccional; exige `401` y ninguna sesión nueva. Repite cambiando el rol entre las dos lecturas y exige que el JWT refleje el rol más reciente.
- Suite completa: credenciales, registro, invitaciones, lifecycle, sesiones/cookies/CSRF, RLS de tablas ya protegidas y PostgreSQL non-owner no deben retroceder.

## Trabajo pendiente para cerrar #232

Revisar con Security Owner diseño y costo de descubrimiento multiempresa compatible con FORCE RLS. Alternativas: función SECURITY DEFINER con privilegios de bypass explícitos, revisión de propietario y `search_path`, o enumeración tenant-local sin bypass pero costo de consultas proporcional a empresas. No confiar en un GUC que el rol runtime pueda falsificar como identidad global. Después diseñar migración + pruebas de upgrade/rollback y policy/permissions. **No activar FORCE RLS indiscriminadamente**: el selector multiempresa usa una lectura global legítima que hoy no tiene reemplazo revisado.

Staging físico/Android/iOS `NOT_RUN`. Release #130 `NO_GO`. No se realizó ningún deploy.
