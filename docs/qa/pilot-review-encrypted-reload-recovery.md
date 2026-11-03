# SedeAgro 0.1 · Recuperación cifrada de revisiones después de recargar

**Fecha:** 2026-11-03 · **Alcance:** frontend del piloto, continuación de PR #279 y #280. **Sin despliegue.**

## Contrato funcional

La revisión independiente (`POST /work-orders/:id/executions/:executionId/review`) ya tiene idempotencia real de backend por `client_request_id`, revisor y empresa; no se inventan ACKs. La brecha era que el navegador perdía el UUID y el cuerpo de esa decisión tras recargar, especialmente si la red había perdido una confirmación HTTP.

Esta entrega reutiliza **`createEncryptedCreateJournal`** sin alterar su esquema, claves de otros dominios ni la cola offline:
- Base independiente `sedeagro-work-order-review-recovery-v1`, dos stores (`pending-creates` y `scope-keys`), clave AES-256-GCM no exportable, IV fresco de 96 bits y AAD de dominio/version/scope/UUID. **Cifrado local en reposo, no cifrado extremo a extremo**: scripts del mismo origen podrían descifrar.
- El scope persistido NO contiene tenant, revisor, orden, reporte, contenido ni checklist en claro: es el hash SHA-256 con dominio de (tenant UUID + user UUID + order UUID), con la etiqueta `review:`. El UUID aleatorio del intento es metadato de recuperación, no una credencial. IDs y cuerpo estricto van **solo dentro del texto cifrado**. No hay token/JWT/cookie, `localStorage` ni `sessionStorage` para el intento.
- Al abrir una orden para revisión, una sesión **autenticada en el servidor**, membresía activa y rol de coordinación son prerrequisitos para consultar el journal. Hasta terminar el read/decrypt las opciones de revisar están bloqueadas. Si falla IndexedDB, WebCrypto, el descifrado, la integridad o falta la clave, se falla **cerrado**: no se envía ninguna revisión y no se borra el ciphertext.
- Antes de **cualquier primer POST**, `savePendingReview` confirma el commit del journal. `add` (no `put`) impide sobrescribir una clave/decisión de otra pestaña. No se guarda evidencia ni datos personales adicionales en esa base.
- Si el HTTP ACK se pierde y el usuario recarga, la UI vuelve a identificar el intento **solo** bajo la misma cuenta y empresa autenticadas y la orden exacta. Hace únicamente un **GET autenticado**; compara servidor y revisor, decisión, reporte, checklist/motivo exactos. Un match autoritativo elimina el journal mediante compare-and-delete transaccional por UUID y recarga el detalle. Un GET ambiguo/inaccesible/con estado diferente conserva el intento y bloquea decisiones nuevas.
- Si el POST original nunca llegó, se permite **solo mediante acción explícita del revisor** recuperar y transmitir el mismo cuerpo descifrado y UUID. Antes del reenvío se lee nuevamente el registro cifrado; otro contenido, falta de registro, usuario o empresa distintos impiden el POST. El servidor decide `replayed: true/false` y conserva RLS, auditoría y las condiciones de revisión.
- No se hacen envíos de revisión en background, ni hay reintentos automáticos al entrar/reconectar. Una decisión `verified` sigue siendo una comprobación administrativa, **no certificación física**.

## Aceptación automatizada

`frontend/test/workOrderReviewRecoveryJournal.test.js`: identidad opaca determinista y separación por tenant/actor/orden, contrato estricto de campos (no secretos ni checks parciales), denegación a roles incorrectos o membresía bloqueada, fail-closed sin IndexedDB y obligación de aguardar el commit antes del POST.

`scripts/acceptance-browser-review-inbox.mjs`: Playwright/Chromium, React, cookie HttpOnly, Express y PostGIS reales con base `*_test` descartable:
1. Segundo actor informa un parte. Coordinación revisa realmente y el backend hace **COMMIT**; Playwright pierde solamente el ACK HTTP, se simula un error 503 temporal en el GET de reconciliación. El navegador comprueba IndexedDB real: solo scope SHA-256, UUID, IV y bytes AES-GCM; CryptoKey nonextractable. **Recarga completa**, revalida cookie real, abre orden, GET autorizado confirma la revisión y elimina exactamente el registro cifrado, **sin repetir POST**, con una sola auditoría y recibo.
2. Otra orden: Playwright aborta el primer POST **antes de salir del navegador** (el servidor conserva `submitted`). La UI preserva el UUID cifrado y, tras recarga y GET real sin confirmación, bloquea revisión nueva; el usuario hace retry explícito con cuerpo y UUID *idénticos*. El primer POST exitoso real hace **un único COMMIT** y la auditoría queda una sola vez.

No se fingen respuestas HTTP 200 ni se modifica la validación PostgreSQL/RLS. El escenario de fallo 503 es deliberado, nunca usado para probar éxito.

## Riesgos y rollback

- Chrome/navegador debe soportar HTTPS/WebCrypto e IndexedDB; si está bloqueado o sin espacio se informa y **no se envía** el POST. En un dispositivo compartido, el almacenamiento cifrado queda en el origen hasta que la revisión se confirma. La clave local está en el mismo origen (protección en reposo; **no es defensa contra XSS o un usuario con acceso al navegador**). Política de retención del journal pendiente debe definirse con seguridad; no se auto-borran casos ambiguos.
- Session scope depende de la autoridad del cookie/`auth/me` actual; almacenar un recibo nunca concede autorización, ni evita revocación de un miembro o cambio de empresa.
- Rollback del frontend: conservar IndexedDB y la implementación del journal para que solicitudes pendientes puedan recuperarse después; **no borrar la base ni keys mediante un deploy**. Rollback servidor no forma parte de este PR.
- Sin cambios de migraciones, backend, permisos, RLS, workflows, VPS, staging o producción. No se ejecutaron pruebas físicas Android/iOS ni aprobación formal Product/Security: issue #130 sigue **NO-GO**. Publicar resultados CI exact-HEAD y postmerge por separado, sin ocultar flakes previos de sesión/SyncPage.
