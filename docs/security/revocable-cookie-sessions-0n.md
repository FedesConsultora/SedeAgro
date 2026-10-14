# Bloque 0N — Sesiones revocables y cookies HttpOnly para navegador

## Cambio verificable

Antes del Bloque 0N, el SPA guardaba el JWT completo en `localStorage`; cerrar sesión solo borraba la copia local sin revocar ese token ante el backend. La sesión seguía reutilizable hasta expirar.

Ahora cada `/auth/login` o `/auth/register-tenant` genera una sesión con identificador aleatorio `jti`, registrada en `auth_sessions` con `tenant_id`, `user_id`, `expires_at` y `revoked_at`. La tabla tiene **RLS FORCE** tenant, y el backend consulta la fila vigente en cada solicitud autenticada. Revocar la fila invalida el JWT de inmediato en todos los procesos; la vigencia máxima sigue siendo de 12 horas. La operación `POST /api/v1/auth/logout` marca la sesión revocada y limpia la cookie.

### Modalidad web (nuevo contrato)
- Login/registro con `x-sedeagro-session: cookie` y `credentials: include` devuelve cookie `sedeagro_session` con `HttpOnly; SameSite=Strict; Path=/api` y `Secure` cuando `NODE_ENV=production`. La respuesta JSON **no incluye token**.
- Los POST/PATCH/DELETE y demás métodos mutadores autenticados mediante cookie requieren `x-sedeagro-request: 1`; una solicitud mutadora sin ese header devuelve 403. El CORS del backend sigue validando orígenes. Ambos mecanismos deben conservarse en el borde; **no sustituye una estrategia formal de CSRF tokens si el esquema de origen/cookies cambia**.
- El frontend nunca lee la cookie ni escribe JWT en `localStorage`; borra `sedeagro.session` legado al iniciar. Solo persiste `sedeagro.tenantHint` (identificador de tenant, no secreto) para enrutar `GET /auth/me` en la siguiente recarga. Esa petición valida cookie, sesión DB, tenant y membresía activa antes de montar la UI; si falla se vuelve al login sin borrar borradores cifrados.
- El alcance de IndexedDB sigue siendo `tenant_id:user_id` con una marca de autenticación validada, no con acceso al JWT. Los borradores y claves de cifrado no se eliminan al cerrar sesión; solo se muestran al reingresar al mismo usuario/tenant.
- El logout en el frontend **espera confirmación del servidor**. Si no hay conexión, deja al usuario identificado y muestra un error: no promete una revocación no confirmada.

### Modalidad API / compatibilidad
- Los clientes API existentes que usen `Authorization: Bearer` sin `x-sedeagro-session: cookie` siguen recibiendo un JWT en JSON (compatibilidad explícita). Deben guardarlo en almacenes de credenciales confiables.
- El servidor prioriza Bearer cuando el header Authorization está presente para evitar confusión de identidades. No acepta un Bearer inválido como fallback a otra cookie.
- Los JWT sin `jti` (emitidos antes de la migración) se rechazan fuera de `NODE_ENV=test`. La excepción controlada en `test` permite ejecutar fixtures históricos de integración que firman tokens sintéticos sin sesión persistida. **La actualización en producción exige que los usuarios vuelvan a iniciar sesión**; no puede hacerse rolling deploy contra nodos antiguos antes de ejecutar la migración del esquema.

### Base de datos y consistencia
- Migración `202610140006_auth_sessions.js`: tabla, índices, FK, RLS y política por `app.current_tenant`. La aplicación HTTP debe utilizar rol PostgreSQL no privilegiado conforme a `docs/security/postgres-rls-runbook.md`.
- Login para empresa existente usa `withTenantTransaction`. El registro crea la sesión dentro de la misma transacción que crea tenant/usuario/membresía. El identificador de sesión se persiste **antes de confirmar HTTP**, evitando cookies válidas sin fila.
- Los registros caducados permanecen en la tabla hasta un mantenimiento autorizado. Futuro: trabajo programado con retención máxima acotada e índices revisados; no ejecutar DELETE general automático en producción sin plan.

### Verificación
- Unit tests: atributos HttpOnly/Strict/Secure/Path, parseo de cookies, prioridad Bearer, CSRF por mutación y scope offline sin JWT.
- PostgreSQL real: registro/login, sesión cookie sin token en JSON, cookie en `/auth/me`, rechazo sin encabezado en `/logout`, revocación persistida y rechazo de replay, con independencia de otra sesión Bearer.
- CI existente vuelve a correr todo PostgreSQL/PostGIS, RLS multiempresa, Chromium offline, Nginx CSP y build Vite.

### Riesgos y límites pendientes
- **HttpOnly limita la extracción directa del JWT por JavaScript, no evita acciones maliciosas del mismo origen ni garantiza protección XSS completa.** CSP mantiene estilos inline por compatibilidad.
- Se usa una cookie de sesión de hasta 12 horas, sin refresh token ni rotación automática. Un navegador completamente offline puede abrir la interfaz cacheada pero **no revalidar la sesión después de reiniciarlo** hasta recuperar conexión; el borrador cifrado permanece protegido en IndexedDB.
- La sesión está asociada a un único tenant seleccionado; al cambiar de empresa se emite otra sesión y la cola no mezcla borradores.
- El despliegue requiere migración y reinicio coordinados, restauración probada en staging y revisión de CORS/HTTPS/cookies detrás del proxy. No se ha desplegado al VPS ni verificado una app móvil nativa.
