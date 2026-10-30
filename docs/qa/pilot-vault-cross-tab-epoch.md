# MOB-05 — Serialización de mutaciones del vault entre pestañas del mismo origen

**30/10/2026 · base main `3d09166df773cfa9662627897cffe2643b62e88f` · release #130 NO-GO.**

## Hallazgo

La PR #270 impide operaciones tardías dentro de **una instancia de JavaScript** usando una generación en memoria. Sin embargo, dos pestañas de `https://<mismo origen>` comparten IndexedDB y **no** comparten ese valor. Por eso, una limpieza empezada en pestaña A puede quedar esperando `indexedDB.open`, mientras B verifica su identidad con el servidor y prepara un sobre cifrado nuevo. Si A reanuda después, el `delete('active')` antiguo podía borrar el acceso local de B.

## Límite y mecanismo

- La creación del vault y su borrado emiten de forma **sincrónica**, antes de PBKDF2, `indexedDB.open` u otros `await`, un marcador aleatorio UUID en la clave compartida `sedeagro.offline-vault-epoch-v1` de localStorage. Es **solo un orden de mutaciones**, jamás sesión, token, passphrase, cookie, usuario, empresa, autorización ni dato de borrador.
- Antes de escribir o borrar, la operación comprueba que su marcador siga siendo el actual, **dentro del callback de transacción IndexedDB**. Si otra pestaña inició una mutación más reciente, la antigua no borra ni reescribe el sobre nuevo. El borrado confirmado y actual sí opera. Los borradores y fotografías se preservan.
- Desbloquear offline captura el marcador compartido antes de leer/desencriptar. Una mutación de otra pestaña durante la espera invalida la apertura; el ticket de capacidad existente también comprueba el marcador antes y después de cada operación local. Ninguna vía autoriza operaciones HTTP/sync offline.
- Si el navegador tiene `window` pero niega localStorage, las escrituras de recuperación fallan de forma visible; no se simula protección multi-pestaña. El cierre de sesión del servidor se sigue completando, el vault se bloquea en memoria y se debe limpiar almacenamiento del sitio si falla la eliminación.
- Compatibilidad: no se altera el formato de `sedeagro-field-offline-vault` ni el cifrado AES-GCM/PBKDF2, ni el formato de la cola de observaciones. El marcador no contiene datos personales.

## Evidencia de pruebas

1. `frontend/test/offlineVaultCrossTabEpoch.test.js`: dos pestañas simuladas con almacenamiento compartido, solo UUID aleatorio; A queda obsoleta tras reclamo de B; corrupción o bloqueo de almacenamiento se rechaza; pruebas estáticas verifican uso del marcador en `put`, `delete`, `unlock` y capacidades.
2. `scripts/acceptance-browser-cookie.mjs`: contra Express real, PostgreSQL/PostGIS descartable, Chromium y autenticación real, crea **dos páginas del mismo BrowserContext** (mismo origen/IndexedDB). A detiene únicamente `indexedDB.open` de su vieja limpieza; B revalida `/auth/me`, prepara un nuevo sobre cifrado, A reanuda; la IV del sobre de B sigue intacta y el vault continúa presente. La prueba no escribe frases, cookies ni IDs en logs.
3. Permanecen todas las pruebas existentes sobre logout servidor HTTP 204, revocación remota JTI, falta de almacenamiento, prueba navegador offline y membresías FORCE RLS. Premerge requiere CI exact head 5/5 y posmerge 7/7.

## Riesgos residuales — no certificar hardware ni seguridad de código no confiable

El contrato cubre **pestañas cooperativas que ejecutan esta versión del código y comparten origen + localStorage + IndexedDB**. No es una barrera frente a scripts maliciosos del mismo origen, versiones viejas de la aplicación, limpieza manual de datos, datos de otro navegador/otra PWA sin storage compartido o carrera de autorización entre backend y desconexión. El estado de seguridad del backend sigue siendo la autoridad al reconectar.

No se probó todavía Chrome Android / Safari iOS físicos, PWA cold-start/cierre forzado, entrega de dispositivo, aprobación del Security Owner ni staging TLS/rollback (#163/#166). No desplegar ni declarar GO.
