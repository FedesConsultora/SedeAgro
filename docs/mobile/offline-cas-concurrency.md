# 0S.10 — Compare-and-swap de capturas offline entre pestañas

## Problema cerrado

Los envíos a PostgreSQL, la carga independiente de fotografías, `discard`, `allowRetry` y la conciliación de recibos podían consultar un registro cifrado, esperar la red/WebCrypto y **sobrescribir o eliminar una versión modificada por otra pestaña**. Los Web Locks limitaban los envíos simultáneos, pero no todos los escritores locales los adquirían y no están soportados en todos los navegadores.

## Contrato de almacenamiento

`indexedDbQueueStore.get/list` descifran AES-256-GCM y vinculan internamente cada objeto devuelto a la **revisión opaca del cifrado que realmente se leyó**. La revisión utiliza los 12 bytes aleatorios del IV de AES-GCM, que ya cambian con cada nuevo cifrado; no se copia al payload, no se convierte en un contador de servidor y no revela la identidad del actor.

Un `put(next,{ expected: original })` o `delete(id,{ expected: original })` verifica ese sello **dentro de la misma transacción readwrite de IndexedDB** donde decide guardar o borrar. Si la fila cambió o desapareció, devuelve `false` sin modificar datos. **No se deja abierta una transacción IndexedDB mientras se espera WebCrypto o red**: el cifrado de `next` ocurre antes y el compare/write es inmediato.

Un `put(newDraft)` **sin `expected` es solo inserción** (IndexedDB `add`), lo que evita que un UUID de borrador duplicado reemplace silenciosamente otro archivo. Las revisiones se mantienen en un `WeakMap` local, no en localStorage, cookies, base aparte ni cambios de esquema. La base continúa en **versión 2**, compatible con v1 en la migración de los borradores previos.

Las llamadas del motor de cola usan siempre la revisión de la lectura más reciente para:
- borrar voluntariamente, reintentar y liberar un borrador confirmado por recibo personal;
- cargar solo la foto pendiente y retirar la copia únicamente con el ACK de evidencia;
- procesar el batch: marcar observación aplicada, subir foto, retirar la copia después del ACK exacto;
- registrar intentos/reintentos/error ante fallo de red o autorización.

Cuando la revisión cambia, **no se informa éxito ni se intenta restaurar una versión anterior**. El operador puede refrescar Sincronizaciones para consultar la versión actual. La comprobación de igualdad del contenido sigue complementando al sello de cifrado, pero no sustituye la transacción atómica.

## Validación automatizada

- `frontend/test/offlineCas.test.js`: simulador con versiones por fila y cambio externo justo antes de cada commit: descarte, retry, conciliación, batch ACK, foto ACK, subida parcial, fallo de red, misma data con IV cambiado, recuperación individual, caso feliz.
- `frontend/test/offlineBrowser.mjs`: dos pestañas Chromium reales compartiendo la misma base IndexedDB cifrada; una guarda cambios, la otra intenta `delete` y `put` con su instantánea antigua y ambos deben devolver `false`. Después una lectura fresca puede borrar la fila confirmando que se eliminó **solo** la revisión correcta.
- GitHub Actions exact-HEAD: frontend tests, build Vite, RLS/PostGIS y Chromium browser-offline.

## Límites y aceptación

Se conserva el alcance de seguridad de la aplicación web: un script malicioso del **mismo origen** con acceso a sesión/WebCrypto no queda protegido por CAS. Tampoco CAS prueba que el servidor no haya aplicado una operación si se perdió el ACK: se mantiene el flujo idempotente y de conciliación.

Se deben probar iPhone/Android físicos con dos pestañas y conexiones intermitentes antes del piloto. No hay cambios en backend, RLS/PostGIS, migraciones de servidor, autenticación, GPS ni despliegue de producción.
