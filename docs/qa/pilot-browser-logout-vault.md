# 0U — Chromium real: retiro del vault por 401 y logout con fallo IndexedDB

**Ámbito:** aceptación piloto #166, MOB-05 #163, cierre seguro #267. Fecha: 29/10/2026. **Entorno de prueba:** Playwright Chromium + frontend React/Vite + backend Express real + PostgreSQL/PostGIS descartable con cookie HttpOnly, usuarios y membresías reales. **No equivale a QA en Android/iOS físicos o staging**. Release #130 permanece NO-GO.

## Fallo que se busca impedir

Un servidor puede confirmar `POST /auth/logout` aunque el navegador rechace borrar el sobre de identidad del vault offline en IndexedDB. El frontend **no** debe conservar una vista autenticada ni confundir la falla local con una falla del servidor. Tampoco debe conservar el sobre después de una respuesta `401` verdadera de una sesión revocada en otro dispositivo, pero nunca debe invalidar un login nuevo por un `401` viejo.

## Escenario E2E incorporado

Amplía `scripts/acceptance-browser-cookie.mjs` sin crear infraestructura duplicada:

1. Registrar tenant A mediante UI real y verificar cookie `sedeagro_session` HttpOnly SameSite Strict y datos no persistidos como JWT en localStorage.
2. En página A, visitar `Sync`, habilitar recuperación offline con frase fuerte **tras GET /auth/me real** y comprobar que el objeto `active` AES-GCM quedó en IndexedDB.
3. Ingresar con la misma cuenta en otro **BrowserContext** aislado B, y habilitar un segundo vault de esa sesión.
4. Desde A revocar realmente el JTI de B, comprobar `GET /auth/me = 401` para B y disparar una lectura propia `GET /auth/sessions` que retorna 401; el listener exact-scope/epoch de B debe cerrar React, retirar el sobre `active` de su IndexedDB y eliminar la cookie. El test espera la transacción completada, no un timeout arbitrario.
5. En A, interceptar **únicamente** `IDBObjectStore.delete('active')` de `offline-vault` para provocar rechazo real del almacenamiento, sin interceptar/cambiar `POST /auth/logout`.
6. Confirmar respuesta HTTP 200 del logout, pantalla de login visible, cookie HttpOnly ausente, tenantHint retirado y `GET /auth/me = 401`. El test requiere que el error de IndexedDB se haya ejecutado, que el sobre cifrado todavía exista y que se muestre el mensaje honesto de limpieza manual del sitio.
7. Cerrar ambos contextos, liberar procesos/tenant de prueba como la suite original, sin registrar secreto, cookie, datos GPS/fotos o contenido del vault.

## Criterios y límites

- Debe aprobar **browser-postgis exact SHA**. Los controles estáticos `frontend/test` y Chromium offline existentes no se sustituyen.
- Verificar CI de PR y CI de `main` independientemente. Un resultado local de la fuente **no** se contabiliza como PASS del navegador.
- No se ejecuta una retirada del vault con Safari/iOS físico, Android, cambio de cuenta sin red, almacenamiento compartido o revocación remota estando desconectado. Estos quedan para la matriz #163/#166.
- Si la transacción de borrado falla, el sobre cifrado conserva su riesgo residual: bloquear la capacidad en memoria no garantiza borrar información física; advertir al operador es parte del contrato. **No tocar producción, staging ni dispositivos reales sin permiso.**

## Referencias técnicas

- Frontend: `frontend/src/context/SessionContext.jsx`, `frontend/src/services/offlineVaultRetirement.js`, `frontend/src/services/offlineFieldVault.js`.
- Navegador real: `scripts/acceptance-browser-cookie.mjs`, gate de GitHub Actions `browser-postgis`.
- QA de reparación: `docs/qa/pilot-session-vault-retirement.md`.
