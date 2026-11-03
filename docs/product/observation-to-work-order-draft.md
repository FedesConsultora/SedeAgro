# SedeAgro 0.1 · De observación persistida a borrador de orden

**2026-11-03 · Piloto / bloque 0R.3 · Coordinación #18, aceptación #166, release #130 (NO-GO).**

## Brecha funcional y contrato existente

El piloto requiere conectar **recorrida → observación GPS/foto → orden → ejecución/revisión → reporte**. Hasta este bloque, Monitoreo mostraba observaciones persistidas pero no permitía preparar directamente una orden de inspección desde un hallazgo. La persona debía volver a Órdenes, buscar otra vez el lote y completar manualmente el contexto de campaña, creando riesgos de selección errónea.

El backend **ya soporta** `POST /api/v1/work-orders` con `field_id` y `campaign_field_id`: verifica autorización de `orders.write`, entitlement `work_orders`, pertenencia al tenant y, bajo la misma transacción RLS, que el lote de campaña corresponda al lote de la orden. El recibo idempotente por `client_request_id` y la recuperación AES-GCM IndexedDB existentes se conservan sin rediseño.

## Recorrido entregado

1. Un administrador de empresa o coordinador autenticado abre una **recorrida y observación existentes** en Monitoreo. Se exige que estén presentes en el detalle devuelto por backend y que el actor tenga entitlements `scouting`, `work_orders` y `gis`; no se muestra la acción en mock, scout, productor ni contratista.
2. **Preparar orden de inspección** navega a Órdenes con un objeto **solo en memoria React**, acotado a tenant, actor, membresía/rol e IDs de recorrida, observación, lote y lote de campaña. No se copian notas, coordenadas, EXIF ni bytes/nombres de fotografías, ni se escriben datos de navegación en storage o URL.
3. Se abre **Nueva orden de trabajo** y se precargan lote/campaña (lote bloqueado en ese flujo), tipo `inspection`, título e instrucciones de verificación, y prioridad sugerida por severidad: leve→baja, moderada→normal, alta→alta, crítica→urgente. **No se prescribe** aplicación química, dosis o trabajo automático.
4. El operador puede corregir título, prioridad, fecha e instrucciones y decide explícitamente si guarda. Una referencia **textual** a ambos UUID se deja en instrucciones. Es contexto humano, **NO una FK directa `work_orders → scouting_observations`**. No decir que el código ha creado asociación relacional o trazabilidad de evidencia automática.
5. El formulario envía `campaign_field_id` al backend junto con el mismo `field_id` e `client_request_id`. Antes de cada POST, el cuerpo original queda cifrado y duradero en IndexedDB. Tras un ACK ambiguo o recarga, la **recuperación anterior tiene prioridad** sobre cualquier precarga nueva: no se ejecuta otro POST ni se genera otro UUID automáticamente. Si el servidor confirma la creación del mismo cuerpo, el recibo se retira mediante CAS y se muestra la orden auténtica.

## Aceptación automatizada

- **Pruebas puras:** alcance estricto de actor/tenant/membresía/entitlement, UUID, observación existente en detalle autorizado, tipo y severidad, ausencia de fotos/GPS/notas en la navegación, sugerencia de prioridad y control anti-invención de tratamiento. Contrato de wiring React y de la recuperación cifrada.
- **Chromium + Express + PostGIS descartable:** `scripts/acceptance-browser-evidence-history.mjs` utiliza la misma recorrida y observación real que prueba evidencia privada. Con entitlement `work_orders` habilitado en esa base descartable, hace clic en la acción de la observación, confirma lote y prioridad, comprueba que la descripción NO copia notas, envía **un POST real explícito** y exige HTTP 201, `replayed:false`, actor/tenant/lote/campaña/tipo/estado exactos, **una fila real SQL** y retorno a Monitoreo, sin alterar la evidencia privada previa.
- El gate no sustituye ninguna autorización exitosa con `route.fulfill(200)` y no toca producción o staging. El resto de la aceptación de evidencias/GPS/tenant se ejecuta completo.

## Seguridad, límites y rollback

- Sin migraciones ni cambios de API, roles, FORCE RLS, sesiones, claves AES-GCM, manejo de fotos, JWT, workflows, VMs, DNS ni deploy. Se usan las validaciones originales del backend. La UI nunca es autoridad de permisos.
- La referencia textual a una observación **no prueba por sí sola** que la orden siga relacionada a su hallazgo si alguien edita instrucciones, ni da acceso a la observación a un contratista. Una relación relacional con visibilidad por rol exigiría otro diseño/migración/revisión.
- No se realizan inspecciones, aprobaciones ni ejecución automáticamente. La orden comienza en `draft` y respeta sus transiciones/capabilities normales.
- Si el operador pierde acceso o el lote ya no es consultable, no se podrá crear esa orden. El backend responde 403/404/422 según autorización/pertenencia y el cliente conserva su copia incierta.
- Rollback de frontend/helper/test/docs; no hay DDL que revertir. Una orden ya creada por una persona no debe borrarse como parte de revertir código.
- **Aprobar CI exact-head PR y CI independiente `main`** antes de cerrar esta entrega. La CI Linux no representa aceptación física de Android/iOS ni staging HTTPS, y #130 sigue **NO-GO** a falta de pruebas de campo y firmas Product/Security.
