# Piloto SedeAgro 0.1 — alta segura de primera empresa

**Cadena:** registrar empresa → usuario fundador con rol tenant_admin → sesión → establecimiento/lote/campaña. Base `main@33e62df34d957c25eb8e8b4757b8a1f31dd66eb2`. Coordinación #18, matriz #166, release #130 NO-GO.

## Riesgo verificado en el código anterior

`RegisterPage.jsx` usaba únicamente el estado React `loading` para deshabilitar el botón. Dos submits antes del siguiente render podían despachar dos peticiones `POST /auth/register-tenant`, ruta que crea usuario, tenant y membresía, y emite una sesión. Ante cualquier respuesta 2xx el formulario llamaba `login()` sin comprobar que tenant, email, nombre, identificadores ni rol coincidieran con el registro solicitado. `Number` y transformaciones de slug podían además enviarse sin validación previa; la política de seguridad de contraseña queda a cargo del backend.

## Implementación

- `prepareCompanyRegistration()` crea un snapshot inmutable **sólo en memoria** del nombre, slug, email, nombre del administrador, clave y plan `starter`, con validación previa de longitudes, identificador, email y longitud mínima. Nunca se imprime ni se guarda en LocalStorage, SessionStorage, URL o analítica.
- `createCompanyRegistrationGate()` adquiere un ticket sincrónico antes del `fetch`, protegiendo contra doble clic, tap y Enter simultáneos. Los inputs se bloquean durante POST.
- Sólo se llama a `login()` si `verifyRegisteredCompany()` observa UUID válidos de usuario/tenant/membresía, empresa exacta, datos del actor, rol `tenant_admin`, membresía `active`, array de entitlements y respuesta sin bearer token legible en modo cookie.
- Las respuestas de rechazo conocido (validación 400/422, conflicto 409, autorización 401/403 o límite 429) liberan la barrera para corregir datos y volver a intentar.
- Un 5xx, timeout, conexión cortada o respuesta 2xx inconsistente puede ocurrir después del COMMIT: queda bloqueado ese formulario y explica cómo revisar el resultado mediante ingreso normal **sin duplicar la empresa**.
- Un resultado tardío de un componente desmontado no puede abrir otra sesión desde esa pantalla. No hay reintento automático, ni modificación de cookies en el frontend.

## Verificación y pruebas pendientes

`frontend/test/companyRegistrationSafety.test.js` cubre normalización, rechazo de datos inválidos, doble POST sincrónico, confirmación exacta de tenant/actor/rol, 2xx falsos, recuperación ante rechazos conocidos, resultado ambiguo bloqueado y wiring del formulario.

Pruebas reales necesarias: crear una empresa con slug único en staging, comprobar una sola fila en la DB y membresía `tenant_admin`, ingreso cookie HttpOnly, errores 422 y 409 sin duplicación, doble tap iOS/Android, simular ACK perdido y verificar que el operador puede entrar con la cuenta ya creada en vez de volver a registrar. **NOT_RUN** sin autorización de staging.

## Límite de seguridad

`POST /auth/register-tenant` continúa sin clave persistente de solicitud. El gate protege una apertura del formulario: no garantiza exactly-once tras recarga, navegador distinto o error de proxy. Cualquier garantía interdispositivo necesita diseño transaccional separado, con control de sesión, email/slug único y tests PostgreSQL reales. No se alteran backend, RLS, migraciones, esquema de cookies, política de contraseñas, CI ni producción.

Hasta verificación independiente del nuevo `main` y pruebas de campo: **NO-GO**.
