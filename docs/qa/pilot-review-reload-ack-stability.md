# SedeAgro 0.1 · Recibo cifrado de revisión: lectura estable tras recarga

**2026-11-03 · Piloto #130 (NO-GO) · Coordinación #18.** La corrección es un gate de aceptación y observabilidad de pruebas, no un cambio del contrato de negocio ni un despliegue.

## Incidente real y alcance

En la CI independiente de `main@319c624fbbbe3dbb1706fdaba8c12f90df67e84b`, primer intento del [run 41644306639](https://github.com/FedesConsultora/SedeAgro/actions/runs/41644306639), el job `browser-postgis` falló en `acceptance-browser-review-inbox.mjs:974`. Tras el flujo de **COMMIT real** de revisión + ACK HTTP perdido + 503 temporal de GET + recarga + conciliación autorizada, una primera espera observó 0 recibos y la lectura siguiente observó **1**. El mismo SHA aprobó la reejecución del job. Esto se trata como intermitencia sin causa raíz de producto demostrada, **no** como éxito de la primera corrida ni como prueba de que se duplicó la decisión.

## Criterios observables reforzados

1. La captura del recibo cifrado se hace al finalizar la transacción **readonly** completa de IndexedDB (`tx.oncomplete`), no solo al resolver una solicitud `getAll().onsuccess`. Se comprueban las mismas propiedades de seguridad: `ciphertext` binario, IV de 12 bytes, scope opaco SHA-256, CryptoKey no extraíble y ausencia de datos privados visibles.
2. Al recargar, Playwright escucha **solo respuestas HTTP 200 reales de Express** correspondientes al `GET /api/v1/work-orders/:id` exacto del caso; exige **al menos dos lecturas** (detalle y conciliación automática del recibo) y comprueba que una contenga el reporte, revisor, decisión y checklist efectivamente persistidos. No hay `route.fulfill(200)`, interceptación que fabrique autorizaciones ni POST automático.
3. La limpieza cifrada no pasa por una lectura momentánea de 0: debe permanecer vacía durante **cuatro transacciones independientes** separadas por 200 ms. Si la fila reaparece, persiste o se acumula una nueva, el gate falla con el número de filas únicamente; no imprime datos de negocio, ciphertext, UUID ni cookies.
4. Se mantiene el criterio de **exactamente un POST** aun con ACK perdido, una decisión administrativa, un evento de auditoría y un recibo durable del backend. El otro caso, POST que nunca llegó al servidor, sigue requiriendo un reintento manual del cuerpo y UUID originales tras recargar.

## Seguridad, riesgos y rollback

- No se alteran backend, permisos, RLS, JWT, journal AES-GCM, esquema IndexedDB, código de React, cron de sincronización GPS/foto, infraestructura, ni suites de CI. No se descarta jamás un recibo incierto desde el test.
- Una nueva falla del gate debe conservar el log/HEAD/attempt exactos y motivar investigación del estado real de IndexedDB/React; **no** se permite silenciarla mediante nuevos reruns indefinidos ni borrar datos locales.
- La mayor duración de la prueba es deliberada (aprox. 600–800 ms extra tras la eliminación); un caso de persistencia real puede agotar los 15 s acotados, en cuyo caso falla correctamente.
- Reversión: revertir el cambio enfocado de `scripts/acceptance-browser-review-inbox.mjs`; no borrar IndexedDB ni modificar el runtime.
- Staging, Android/iOS físicos, pilotos de campo y aprobaciones Product/Security siguen pendientes; no declarar **GO** comercial por un gate verde.

## Verificación requerida

- Revisar diff y parseo ESM, después ejecutar `browser-postgis` con Chromium + Express + PostgreSQL/PostGIS descartable; exigir CI exacta del HEAD de PR (**5/5**). Confirmar ejecución independiente de `main` (**7/7**) luego del merge, sin atribuir al nuevo código los controles de SHAs anteriores.
- Si el gate revela que el journal efectivamente reaparece bajo el mismo scope, detener la integración e investigar una escritura tardía real del cliente; un cambio de prueba no reemplaza una corrección de producto.
