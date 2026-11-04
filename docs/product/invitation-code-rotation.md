# SedeAgro 0.1 · Reemisión segura de invitaciones manuales

**Bloque 0R.5 · 2026-11-03 · Coordinación #18, P0 histórico #222, aceptación #166 y release #130 NO-GO.**

## Problema real

La invitación por administrador y su aceptación ya existen (backend `/auth/invitations`, `/auth/invite/accept`, frontend Equipo/ingreso, PostgreSQL `member_invitations`, FORCE RLS, tests). El issue #222 describe un HEAD anterior; no corresponde recrear API ni ofrecer tarjetas falsas. Pero el código original **solo muestra la contraseña de invitación una vez** y guarda su SHA-256 irreversible. Si la persona autorizada cierra la pantalla sin copiar el código, debe revocar el registro y crear otro, con doble operación y posible incertidumbre sobre qué código sigue vigente.

## Comportamiento nuevo

1. Una administración de empresa autenticada ve el listado real de invitaciones. Solo una invitación **pendiente y no vencida** ofrece **Reemitir código**. Scout, contratista, productor, coordinación y modo demo no tienen la acción.
2. Antes del envío, la UI exige confirmación de que el código anterior dejará de funcionar, incluso si ya se compartió. Un gate síncrono evita doble clic y la operación queda asociada a identidad, tenant, API y versión de fila.
3. `POST /api/v1/auth/invitations/:invitationId/rotate` exige `members.invite` (solo `tenant_admin`), token de sesión real, protección CSRF del mutador, limitación de 6 reemisiones por ventana de diez minutos y body estricto `{ expectedUpdatedAt }`. Se bloquea la empresa activa y la invitación **en la misma transacción FORCE RLS**. Identificador desconocido o de otra empresa → 404. Aceptada/revocada/vencida → 410. Versión vieja → 409, sin código devuelto.
4. Se reemplaza `token_hash` por SHA-256 de un nuevo secreto aleatorio de 32 bytes, se extiende la validez a siete días y se avanza una revisión `updated_at` monótona. Email, rol, invitador, ID y **un solo asiento reservado** no cambian. El código viejo ya no es reconocido por aceptación. Una segunda reemisión concurrente desde la misma revisión no puede emitir un segundo código exitoso.
5. El audit `member_invitation.rotated` se escribe con la misma transacción sin secretos. Se devuelve `Cache-Control: private, no-store`, datos de invitación y `delivery: {channel: 'manual', delivered:false, token}`. **No existe envío por email ni promesa de entrega.** El nuevo código se muestra solo una vez en memoria React; ninguna lista/GET lo contiene.
6. Ante fallo o ACK perdido, el administrador **no** recupera automáticamente un token ni reenvía el POST. La UI indica actualizar la lista; podrá volver a reemitir explícitamente desde la revisión autorizada más reciente. Si el servidor ya rotó pero el ACK se perdió, el código anterior puede dejar de ser válido y el nuevo será descartado; es deliberado. Nunca se activa una membresía sin que su destinatario demuestre la contraseña.

## Aceptación

- PostgreSQL real no-owner/tenant A+B: autorización, generación del primer código, reemisión, old token 404, new token acepta una vez con 201, no otra membresía, solo un asiento y fila, revocado/expirado 410, versión vieja 409, dos llamadas paralelas devuelven un 200 y un 409, auditoría sin códigos, rol y destino inalterados.
- Chromium real con cookies HttpOnly: registrar empresa, crear invitación desde Equipo, **reemitir** con diálogo, comprobar un solo registro real, negar código antiguo con POST real, aceptar nuevo desde navegador independiente sin cookie, iniciar sesión como scout, refrescar miembros y asignar a equipo; sin HTTP 200 fingidos.
- Contrato de UI: separación demo/live, token solo en memoria, escoping por sesión/API, no persistencia en URL/IndexedDB/localStorage, ACK exacto de empresa/id/email/rol/versión, sin respuestas optimistas ante incertidumbre.
- No se altera facturación de planes, seguridad de login ni roles; no se agregan migraciones ni infra. No se ejecutan deploys/hosts ni staging.
- **Release #130 permanece NO-GO**: Android/iOS reales, staging autorizado, aprobación Product/Security, operación real y distribución del código por un canal privado gestionado por el administrador siguen siendo pruebas/acciones externas.
