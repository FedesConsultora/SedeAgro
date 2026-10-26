# Piloto 0.1 — Recuperación de campañas después de perder el acuse

**Base:** main@5e70fe24302ab2f0a949d04d5641ea2358f86075, issue #211, coordinación #18. Backend de idempotencia (PR previo) ya existe: `campaign_create_requests` con FORCE RLS, actor+tenant+client_request_id, fingerprint SHA-256 y replay atómico. Este PR sólo cierra el hueco del cliente tras recarga/cierre.

## Contrato

1. El usuario debe estar en modo live, con sesión validada, tenant, membership, rol y entitlement de campañas. Nada se restaura con `tenantHint` ni durante pantalla de autenticación no verificable.
2. Antes del primer POST, el navegador cifra el cuerpo completo **con la misma UUID de solicitud** en IndexedDB, utilizando AES-256-GCM, IV aleatorio y autenticación adicional que liga scope+UUID. La clave CryptoKey se guarda no exportable en IndexedDB. No se guarda cookie, JWT ni password.
3. La transacción `add` del slot único por actor/membership/rol/tenant no sobrescribe otro envío pendiente. Si no confirma el COMMIT local (quota, storage, navegador no compatible), **no sale HTTP**.
4. Si el backend confirma la campaña exacta, incluida identidad de tenant y `replayed`, se elimina el slot mediante compare-and-delete sobre la UUID de solicitud y luego se notifica el alta. Una pérdida de red o una respuesta ambigua deja los bytes originales recuperables.
5. Al reabrir un modal o cerrar/reabrir el navegador, se lee el slot del scope autenticado. El nombre y las fechas sólo se descifran para ese actor, nunca se exponen como filas plaintext de IDB. Se bloquea crear otra campaña y se muestra **Reintentar el mismo envío**. No hay POST de fondo, ni en el efecto de restauración.
6. Si el operador comprueba en Campañas que quiere abandonar el intento, puede elegir **Descartar tras revisar Campañas** y confirmar el riesgo de que el servidor ya haya creado ese recurso. Ni cerrar el modal ni cambiar de sesión borran el slot. La eliminación de otra UUID no es posible.
7. El backend vuelve a validar autenticación, permisos y RLS en **cada** replay: un usuario suspendido no puede recuperar capacidad de escritura por conocer una UUID. Un cambio de tenant no autoriza ver el cuerpo previo.

## Límites y pruebas pendientes

- AES-GCM sólo protege bytes en reposo; mismo-origen JavaScript autorizado y extensiones maliciosas podrían leer datos descifrados. **No** es E2EE, ni solución al cold-start offline de #163.
- Si IndexedDB o su CryptoKey se borran, no existe recuperación automática; no reenviar con una UUID nueva sin comprobar primero la lista del servidor. No se almacena ningún dato secreto en localStorage o sessionStorage.
- Las pruebas Chromium cubren cifrado/bytes, recarga, distinta empresa, dos pestañas concurrentes, eliminación con UUID errónea y conservación del envío. El backend ya prueba ACK perdido/replay/concurrencia en PostGIS nonowner.
- Staging autorizado: recrear en Chrome Android y Safari iOS con una campaña real, cerrar navegador después del COMMIT simulando pérdida de ACK, iniciar sesión y recuperar mismo ID; probar cambio de actor, revocación antes de reintento, almacenamiento lleno y borrado intencional. **DEVICE_E2E=NOT_RUN, RELEASE #130 NO_GO, DEPLOY=NO.**
