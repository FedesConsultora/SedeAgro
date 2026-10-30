# Piloto SedeAgro 0.1 — órdenes y recorridas tras COMMIT y ACK perdido

**30/10/2026 · #204 / #207 / #166 · base main `cecf0127aeed5c737cb03ca28e66ec24ecf9a4b7`**

## Descubrimiento

Los issues #204 y #207 describían el estado inicial sin idempotencia persistente, pero el código actual ya incluye `work_order_create_requests` y `scouting_run_create_requests`: reserva en transacción de PostgreSQL, llave única por tenant/actor/UUID, fingerprint de payload, replay con HTTP 200 (`replayed: true`) y 409 ante reutilización distinta. FORCE RLS se prueba con rol no propietario. El navegador también tiene journales AES-GCM separados para cada operación y restauración manual. No corresponde volver a implementar estos mecanismos.

Faltaba probar que **la interfaz React real** aprovecha ambos mecanismos cuando un servidor recibe y confirma un POST, pero el navegador pierde el ACK y recarga la aplicación.

## Configuración y recorrido

- El mismo flujo E2E `scripts/acceptance-browser-cookie.mjs` registra un tenant real en Express/PostGIS, activa una invitación de scout desde un segundo contexto, y crea un establecimiento mediante el formulario real.
- El setup de lote y asociación a una campaña se crea a través de la **API HTTP autenticada real** bajo la cookie HttpOnly del administrador y `x-tenant-id`, sin insertar recursos saltando la política de la aplicación. Se selecciona el cultivo de referencia desde los catálogos de la base de pruebas descartable.
- En **Órdenes**, el admin abre «Nueva orden», ingresa título/instrucciones y selecciona el lote real. El primer POST se deja llegar a Express/PostGIS con `route.fetch()`. Se exige 201, tenant correcto, `replayed=false` e ID original; sólo entonces se aborta la respuesta al navegador.
- La interfaz marca confirmación pendiente y **no reenvía automáticamente**. La base conserva una sola orden. IndexedDB contiene una sola solicitud sellada con UUID original, IV de 12 bytes y ciphertext binario; el título no persiste en claro.
- Después de `page.reload()`, el modal reabre bloqueado con el envío original. El operador pulsa «Reintentar el mismo envío» y el backend real responde 200, `replayed=true` y mismo ID. UI muestra exactamente una orden, PostgreSQL confirma una sola y el journal queda vacío.
- En **Monitoreo**, el admin selecciona el lote/campaña real y asigna al usuario scout efectivamente invitado. La misma pérdida de ACK se fuerza **después de POST 201 y COMMIT**. La consulta SQL exige un único `scouting_run`, un solo evento `scouting.run.created` y una sola notificación de asignación.
- El refresh/reload debe restaurar el cuerpo original (incluyendo `assigned_to`, `summary` y UUID) sin reenvío automático; el reintento explícito exige 200 `replayed=true` y el ID previo. Se vuelve a contar run/auditoría/notificación: exactamente una de cada una. El journal de recorrida queda vacío y la fila aparece en Monitoreo una sola vez.
- La inspección común está en `scripts/support/assert-create-journal-sealed.mjs`, sin descifrar datos ni imprimir cookies, claves, cuerpos o tokens.

## Gates y restricciones

No se modifica auth, permisos, backend, migraciones, contratos REST, almacén offline de observaciones/fotos, CI, infraestructura ni VPS. La prueba no es una simulación de base/HTTP; se interrumpe **sólo la entrega de ACK** de una transacción real.

La aceptación requiere CI exacta de PR 5/5 (tenant-rls/restore, browser-postgis, browser-offline, dependency-security, production-images) y posterior CI independiente del nuevo `main` 7/7 (incluye Sigstore OCI e importación de imágenes).

Esto acredita Chromium headless en CI, no pruebas físicas Android Chrome, Safari iOS, pérdida de radio/celular ni staging; las aprobaciones humanas Product/Security pendientes en #163/#166 y release #130 **NO-GO**. No se despliega.
