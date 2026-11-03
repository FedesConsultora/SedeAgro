# SedeAgro 0.1 · Límite de espera en escrituras offline cuando la red queda colgada

**2026-11-03 — continuación crítica de PR #283; sin despliegue.**

## Evidencia que motivó la corrección

El merge normal de PR #283 sobre `main@f18218cbb1e5c22953a8d9c74e1d1f22c39d87ec` pasó su CI exact-head 5/5 tras una repetición de browser-postgis, pero el `main` independiente volvió a fallar en el gate GPS/foto https://github.com/FedesConsultora/SedeAgro/actions/runs/41642545118. El diagnóstico seguro —sin notas, GPS, nombres ni archivos— mostró:

- **Un** POST batch iniciado por el navegador; **cero** respuestas HTTP y **cero** eventos requestfailed.
- **Cero** observaciones aplicadas en PostgreSQL/PostGIS.
- Browser online, botón de enviar habilitado.
- Borrador AES-GCM intacto en IndexedDB, `state=pending`, `attempts=0`, fotografía original presente, ninguna `syncedObservationId`.

La conclusión acotada es que **el transporte quedó sin resolver**; no hay evidencia de fallo de RLS ni de pérdida de ciphertext. El primer paso de PR #283 limita a 12 segundos la espera de un clic manual por un vuelo ya activo, pero no puede forzar que `fetch` se resuelva cuando la red queda colgada; ese vuelo retiene el Web Lock y el estado `inFlightScopes`.

## Contrato funcional nuevo

En **únicamente** los dos POST de sincronización (batch `POST /sync/batches` y foto `POST /scouting/observations/:id/evidence`), la API aplica un límite de ejecución por transporte:

- Lote: **25 segundos**; fotografía privada: **35 segundos**. Los GET, revalidación de cookies, otras APIs y los cambios de sesión **no** tienen este nuevo timeout.
- Cada escritura recibe un `AbortSignal` propio y propagación del `AbortSignal` externo (scope/session). Al agotarse el plazo, `abort()` cancela `fetch`; incluso si el transporte no coopera, el wrapper rechaza el intento y permite a la cola liberar el lock. Los temporizadores/listeners se limpian al resolver.
- Un timeout **NO prueba que el servidor no haya realizado COMMIT**. El error se clasifica como transporte incierto: la cola conserva AES-GCM, `idempotency_key`, payload original, recibo parcial y fotografía en su mismo scope; el próximo envío reutiliza exactamente las mismas claves y PostGIS aplica idempotencia. Un HTTP exitoso requiere el ACK exacto de batch y foto antes de borrar.
- Al cerrar sesión o cambiar actor, el signal de la sesión cancela cada transporte; el navegador no debe abrir nuevas solicitudes de un scope revocado.
- El click manual sigue esperando hasta 12 segundos el lock del scope como en PR #283. Si la espera expira antes de que termine el transporte, la UI indica **sin confirmación**, no un éxito; el retry automático se programa una vez que el POST colgado termina por el deadline, respetando el backoff original.
- No se agregan retries en un bucle, llamadas a un endpoint alternativo, borrado de borradores, tokens en storage ni manipulación de auditorías.

## QA exigida

- Unit `frontend/test/offlineTransportDeadline.test.js`: operación normal, timeout aunque un `Promise` no respete abort, cancelación por logout, señal previamente abortada nunca envía, límites inválidos, reintento después de timeout preserva UUID/cuerpo, fotografía con observación aplicada sigue en foto-only y verifica wiring solo en las dos escrituras offline.
- `scripts/acceptance-browser-cookie.mjs` existente (sin cambios en este bloque): Playwright Chromium + React + `/auth/me` real + PostGIS de prueba descartable: captura opt-in GPS/foto, fallo de red, reload, cuerpo AES-GCM original, POST del servidor, un único registro, foto privada sin EXIF/GPS. Los diagnósticos de la corrida anterior quedan disponibles para distinguir timeout de falta de señal.
- CI de PR sobre **HEAD exacto**: both workflows (offline-photo-ack y tenant-rls/browser-postgis/browser-offline/dep-security/production-images), luego push independiente main con 7 jobs. Los fallos previos se conservan y no se etiqueta un run anterior como aprobado.

## Riesgos y rollback

- Una subida real muy lenta puede interrumpirse a los 25/35s. Se conserva y reintenta el contenido **idempotente**; el operador debe ver estado incierto y revisar recibos, no eliminar el archivo. La red puede continuar un HTTP iniciado pese al aborto del navegador; backend tenant RLS y deduplicación por UUID siguen siendo obligatorios.
- Es un límite del cliente web, no garantiza Background Sync del dispositivo o entrega móvil fuera de Chrome/Safari abiertos. Web Locks pueden no estar disponibles y el navegador puede eliminar almacenamiento bajo presión.
- Rollback de frontend no requiere migraciones: basta revertir el wrapper y conservar IndexedDB sin limpieza; el servidor mantiene su contrato. Sin cambio de backend, PostGIS/RLS, OAuth/cookies, migraciones, cifrado, endpoints ajenos, VPS, staging ni producción.
- QA física iOS/Android, aceptación del operador de campo, staging HTTPS y firmas Security/Product pendientes. **Issue #130 permanece NO-GO.**
