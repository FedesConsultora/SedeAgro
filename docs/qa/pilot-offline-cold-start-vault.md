# SedeAgro 0.1 — MOB-05: cold start offline con borradores cifrados (#163)

## Diagnóstico reproducido por código

Al reabrir una PWA desde cero sin red, el `SessionProvider` no puede autenticar la cookie HttpOnly a través de `GET /auth/me`. Por seguridad, `sessionCheckError` oculta el Shell y la cola de observaciones. Los borradores, fotografías JPEG, GPS e idempotency keys cifrados en IndexedDB sobreviven a la recarga, pero el usuario no podía volver a verlos. El `tenantHint` en localStorage **no es identidad**. El bug funcional fue observado en código; la aceptación física iOS/Android queda **NOT_RUN**.

## Contrato opt-in: dispositivo preparado en línea

1. En **Sincronizaciones**, autenticado con sesión real y conexión, ingresar una frase de acceso local de 12–128 caracteres (diferente de contraseña corporativa).
2. La interfaz revalida `GET /auth/me` y compara identidad **tenant + user + membership + role**, comprueba permiso `scouting`; si cambia durante la solicitud, rechaza el alta.
3. Sólo se persiste en una base separada `sedeagro-field-offline-vault` un sobre de la identidad mínima (3 UUIDs, rol, fecha de verificación y expiración) cifrado con **PBKDF2 SHA-256 310.000 iteraciones + AES-256-GCM** (salt aleatorio 16 bytes, nonce aleatorio 12 bytes, AAD específico `sedeagro:field-offline-vault:v1`). No se guardan la frase, email, token, cookie, nombre, contraseña del servidor, roles completos ni entitlements. El sobre cifrado no contiene notas ni fotos: esas continúan en la IndexedDB de borradores con su propia clave AES-GCM no extraíble.
4. Es **un dispositivo / una identidad** activa: preparar otra identidad reemplaza el sobre anterior. La habilitación vence a las **48 horas** desde la verificación; un desbloqueo sólo dura 15 minutos, se cancela al ocultar la pestaña, cambiar de pestaña, salir de la página, recibir transición de sesión de otra pestaña o recuperar conexión. Cinco frases erróneas llevan a una pausa de un minuto en memoria. Esta demora es anti-error, **no protección resistente a ataques offline**: debe elegirse una frase de alta entropía.

## Contrato cold-start sin red

1. Si `navigator.onLine === false` y `/auth/me` no se puede verificar, la pantalla de sesión bloqueada ofrece **«Desbloquear borradores de campo sin conexión»**. No se expone este camino como una sesión validada.
2. La frase descifra y valida el sobre local. Se entrega una capacidad no serializable mantenida en un `WeakMap` de memoria, con versión/TTL y revocación de generación. La aplicación no llama a `setSession(authenticated:true)`, no monta Shell ni habilita API. No muestra ni consulta empresas, órdenes, recorridas remotas ni recibos de backend.
3. La vista permite revisar **únicamente** los borradores previamente cifrados de `tenantId:userId` y continuar capturando para `runId` que **ya figure en algún borrador de esa misma identidad**. No crea recorridas nuevas ni presupone que se conserve una asignación del servidor: el backend puede rechazar la observación al reconectar. El guardado en AES-GCM IndexedDB, el límite de 100, la normalización de cámara a JPEG sin EXIF, los UUID e idempotency keys, y el GPS opt-in son los mismos que en el flujo autenticado. No permite descartar ni reenviar borradores mientras el backend está inaccesible.
4. Al reconectar se bloquea el espacio local y el `SessionProvider` exige `/auth/me` antes de reanudar el Shell o los envíos. El servidor sigue validando usuario/rol/tenant, estado de recorrida, RLS, permisos y recibo idempotente. Un usuario revocado remotamente **no puede ser reconocido como revocado mientras no exista conexión**; se reduce la ventana con 48 h, desbloqueo manual y cierre rápido. Nunca interpretar una captura local como observación aplicada en PostgreSQL.
5. `logout` confirmado revoca el JTI servidor e intenta eliminar el sobre de acceso; el cambio de login, la expiración de sesión y los avisos de otra pestaña bloquean/reti­ran el sobre. **Los borradores cifrados se conservan** aunque se retire el acceso local, para no destruir capturas pendientes.

## Límites y seguridad

- AES-GCM en IndexedDB protege contenido **en reposo**, pero cualquier script del mismo origen con capacidad de ejecución puede pedir operaciones criptográficas al navegador. Una frase del vault no constituye almacenamiento hardware, passkey, autenticación biométrica ni garantía criptográfica contra ejecución de código en el origen.
- En navegadores con base de datos borrada, clave perdida, Web Crypto no disponible, pestañas compartidas o PWA sin service worker estable, bloquear y mostrar error; nunca convertir borradores a localStorage o texto plano.
- No se puede garantizar revocación remota al estar desconectado. La política debe ser aceptada por responsable de seguridad y el dueño del piloto. No habilitar en dispositivos compartidos.
- Sólo continuaciones de recorridas que ya tengan un borrador local; **no** descarga offline de empresas, campaña/lote, mapas ni planificación inicial. Esto cubre el caso de *reanudar observaciones* de MOB-05, no un modo offline general.
- El flag `navigator.onLine` no prueba disponibilidad real: el acceso local sólo se ofrece en modo explícitamente offline; conexión parcial con servidor inaccesible muestra error y reintento.
- La frase de acceso puede perderse y no existe recuperación desde servidor ni desde cookies. Los borradores AES-GCM persisten separados de la frase.

## Evidencia y aceptación

- `frontend/test/offlineFieldVault.test.js`: pruebas WebCrypto PBKDF2 + AES-GCM (cifrado, AAD, foto/notas ausentes de sobre, expiración, violación de identidad, secreto incorrecto, tamper), acceso local no restaura cookie/servidor ni usa `tenantHint` como autoridad.
- `frontend/test/offlineBrowser.mjs`: Chromium real usa service worker y bundle productivo, prepara vault con respuesta HTTP /auth/me de fixture, siembra un borrador AES-GCM IndexedDB con ámbito propio, corta completamente la red, recarga PWA, prueba frase errónea, desbloquea y guarda observación; recarga nuevamente sin red y confirma **dos borradores cifrados y cero sesión backend**.
- Exigir CI exact-head 5/5 de PR y postmerge 7/7 independiente; no rebajar autenticación, RLS ni OCI.
- **Dispositivos físicos NOT_RUN**: Android Chrome y iOS Safari: sesión real scout, modo avión, observar+JPEG+GPS opt-in, cierre total PWA, reapertura, revisión, segunda captura, cambio de cuenta, ventana caducada, vuelta en línea 401/403/409 tras revocación y recuperación idempotente. Adjuntar evidencias anonimizadas sin datos de campo reales ni tokens y registrar fecha, equipo, OS, navegador y hashes de pruebas.
- Staging aislado **NOT_RUN**. #130 release **NO-GO**. #166 matriz de actores y #232 revisión security owner siguen pendientes. No se efectuó despliegue, migración backend ni acceso físico.
