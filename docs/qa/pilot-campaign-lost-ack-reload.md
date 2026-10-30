# Piloto 0.1 — campaña creada con ACK HTTP perdido y recuperación tras reload

**Bloque QA #211 / #166, 30/10/2026.** Este escenario es una prueba de navegador sobre infraestructura aislada; no certifica red celular real ni staging/dispositivos.

## Descubrimiento y reconciliación de #211

El issue #211 se abrió cuando existía un guard de UI pero no un acuse durable. En `main@5e886316e78c7dddce505e64aa043a4f22e4938c`, el backend **ya** tiene `campaign_create_requests`, PK por tenant/actor/UUID, fingerprint de payload, `200 replayed=true`, `409` por body distinto y pruebas de concurrencia en PostgreSQL non-owner con FORCE RLS (`backend/test/campaignCreateIdempotency.pg.mjs`). La UI **ya** usa `sedeagro-campaign-recovery` con AES-GCM, clave WebCrypto no extraíble por scope, escritura antes de POST y restauración manual tras reload. No duplicar esta funcionalidad ni declarar #211 cerrado sin aceptación del piloto.

## La prueba real que faltaba

`scripts/acceptance-browser-cookie.mjs` ahora ejecuta un recorrido crítico completo con la aplicación real:

1. Registrar una empresa real en Express/PostGIS descartable y recargar la cookie HttpOnly.
2. Ir a **Campañas → Nueva campaña**. Preparar una solicitud válida con `client_request_id` UUID desde el modal.
3. Interceptar **sólo el resultado del primer POST**, ejecutar el request auténtico con `route.fetch()`, exigir **HTTP 201**, `replayed=false` y `data.tenant_id` del actor; luego `route.abort('failed')` para simular pérdida del ACK **después** de COMMIT.
4. Ver el estado «No pudimos confirmar la campaña», botón Crear bloqueado y **cero reintentos automáticos**. Consultar la DB y confirmar exactamente **una** campaña.
5. Comprobar en IndexedDB una única solicitud pendiente cuyo `client_request_id` coincide, ciphertext binario AES-GCM, IV de 12 bytes y ningún nombre de campaña en texto plano.
6. Recargar la página completa. Volver a Campañas → Nueva campaña. Exigir recuperación de datos del mismo actor y formulario no editable; **sin POST automático**.
7. El operador pulsa «Reintentar el mismo envío». Verificar exactamente la **misma clave y nombre**, **HTTP 200 replayed=true** del servidor auténtico y **mismo ID** del primer 201.
8. Cerrar modal por acuse, mostrar **una** tarjeta de campaña, consultar PostgreSQL y confirmar **un solo registro**. El journal cifrado queda vacío después de un acuse verificado.

No se simula el servidor ni se inserta una campaña artificial: sólo se interrumpe el transporte **entre** el commit real y el navegador. No se imprimen tokens, clave AES, contraseña, cookies, ciphertext ni PII de otro actor.

## Gates y límites

Se exige ejecución premerge en HEAD exacto: `tenant-rls`, `browser-postgis`, `browser-offline`, `dependency-security`, `production-images`. Después del merge, nueva CI independiente sobre `main` incluyendo firmas OCI e importación de imagen. Ningún gate se deshabilita.

Este escenario cubre campañas en **Chromium de CI**, no pérdida real de Wi-Fi/4G, Safari iOS, Android Chrome físico, suspensión de PWA, restauración de caché ni errores de disco/almacenamiento bloqueado. Los tests de backend existentes cubren replay multiworker, conflicto, aislamiento por tenant y revocación; el presente prueba **el vínculo UI→journal→servidor→UI** que no cubrían. #130 permanece **NO-GO**, sin despliegue.
