# 0U / P0 #222 — Invitación a colaborador → aceptación → equipo real

**Fecha:** 30/10/2026. **Origen:** `main@8695b628513daa5cd58db6791b6f11cf6f2feb9c`. Alcance: flujo operativo web con backend real en base PostgreSQL/PostGIS descartable. **Release #130: NO-GO.**

## Brecha operativa

La incidencia #222 fue creada cuando no existía la invitación live. El código más reciente ya implementa `MemberInvitationPanel`, `POST /auth/invitations`, `POST /auth/invite/accept`, membresías activas y `TeamOperationsPanel`, con pruebas aisladas y una cadena API de actores (#265). Sin embargo, **un administrador que permanecía en Equipo mientras el destinatario aceptaba la invitación desde otro navegador no tenía una acción visible para actualizar el padrón y asignarlo inmediatamente a un equipo**. La carga inicial y la mutación de equipo se basaban en snapshots locales; no son una suscripción en tiempo real.

## Cambio de producto

- En **Equipo (modo Backend/live)** aparece `Actualizar equipo` solamente con ámbito de sesión visible. La acción reconsulta **`GET /auth/members`, `GET /teams` y `GET /auth/invitations`** sin recrear ni reenviar invitaciones. Un error de cualquiera de los endpoints mantiene la pantalla sin datos privados del ámbito anterior y muestra un mensaje, nunca rellena con demo.
- Los listados de miembros y equipos se reconstruyen con las verificaciones existentes por tenant, API y sesión. La lista de invitaciones reconsulta al modificar `refreshKey` pero continúa separada de los miembros (pendiente/aceptada ≠ membresía activa).
- La actualización se deshabilita mientras miembros/equipos cargan o hay una transición de acceso en curso. No genera una membresía ni altera permisos por sí sola.
- El código de invitación sigue siendo secreto efímero mostrado únicamente al administrador después del ACK, entregado **manualmente** por canal privado. No se guarda en URL, localStorage, sesión ni logs. El sistema **no** afirma que haya enviado email.

## Aceptación de navegador real, no fixture SQL para el alta

Se amplía el script existente `scripts/acceptance-browser-cookie.mjs` usando el mismo servidor Express, PostgreSQL con rol no propietario, tenant real y cookies HttpOnly:

1. El fundador registra su empresa por la interfaz React y obtiene cookie real.
2. El fundador abre **Equipos**, genera una invitación de rol `scout` y verifica el HTTP **201**, formato secreto tenant-prefijado y mensaje de **no entregada**. El test mantiene el código sólo en memoria y jamás lo imprime.
3. En un segundo `BrowserContext` sin cookie, el destinatario elige **Tengo una invitación**, introduce el código, nombre y contraseña propia y obtiene HTTP **201**. Luego inicia sesión con su propia identidad; se comprueba empresa/rol y acceso a la interfaz.
4. Sin abandonar el primer navegador, el administrador pulsa **Actualizar equipo**. La lista de invitaciones muestra `Aceptada` y el padrón incorpora el nombre real del scout; no se inventa un miembro temporal antes de aceptación.
5. El fundador crea un equipo real por `POST /teams` (201), selecciona al scout recién activado en **Integrante activo** y realiza `POST /teams/:id/members` (201), comprobando su nombre en la tarjeta del equipo después de refrescar.
6. No se debilita autorización ni se alteran rutas del servidor, RBAC, RLS, migraciones, sesión ni el modelo offline.

**Pruebas requeridas:** frontend unit + build, test Chromium de cookie/actor completo, tenant-rls, browser-offline, security, imágenes; CI exact HEAD PR 5/5 y posmerge independiente 7/7. Si falla, corregir según logs, nunca saltar test.

## Límites y aceptación pendiente

- Esto acredita sólo UX funcional navegador Chromium + API real en CI *descartable*. No demuestra entrega de emails, recepción del código por un humano, staging real o navegadores móviles en campo.
- No marcar #222 completamente aprobado sin QA Android/iOS, doble aceptación y revocación humana, límites de plan en el piloto concreto, canal de entrega seguro y firma Product/Security. El código de invitación no sale del dominio de la prueba.
- No modifica producción ni staging. #166 y #130 continúan con aceptación externa pendiente.
