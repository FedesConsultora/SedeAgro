# 0T.16 — Paginación estable y cursor privado de la bandeja de coordinación

## Hallazgos al auditar el main exacto anterior
`GET /work-orders/review-queue?page=N` (0T.15) usaba `OFFSET`. Si se agrega una orden reciente entre la página 1 y la 2, pueden duplicarse órdenes o saltarse registros por desplazamiento. Además, la consulta a partes `submitted/verified` no tenía orden explícito: para dos partes pendientes de una misma orden el resumen podía seleccionar uno arbitrario.

## Nuevo contrato HTTP
`GET /api/v1/work-orders/review-queue` inicia un recorrido y devuelve `pagination: { page_size: 50, has_more: boolean, next_cursor: string|null }`. Con `GET /api/v1/work-orders/review-queue?cursor=...` continúa el recorrido iniciado; el parámetro `page` y cualquier parámetro desconocido dan 422, para no mezclar paginaciones incompatibles.

Cursor opaque **HMAC-SHA256**, firmado con clave del servidor y separador de dominio, incluye exclusivamente versión, usuario/tenant autorizados, timestamp ancla, vencimiento y última tupla (timestamp + UUID de orden). Firma en tiempo constante, encoding canónico, máximo 1024 bytes. Tiene vigencia de 15 minutos. Cada request vuelve a autenticar membresía, rol, entitlement y tenant de RLS; el cursor no es una credencial de acceso ni cambia esos permisos. Un token alterado, vencido, prestado a otro usuario/empresa o con forma inválida se rechaza **422**, nunca se interpreta como otro tenant. No se almacenan cursores en servidor ni se registran valores del token en logs.

Las órdenes se ordenan por `date_trunc('milliseconds', created_at) DESC, id DESC` para canonizar el nivel de precisión de fechas de JavaScript respecto del timestamp PostgreSQL. La siguiente página utiliza exclusivamente la condición estricta de keyset `(date_trunc(...) < lastDate) OR (date_trunc(...)=lastDate AND id < lastId)`, acotada al timestamp inicial `created_at <= anchor`. Nuevas órdenes creadas después del ancla no desplazan las páginas y no entran hasta pulsar **Actualizar pendientes**. No se usan `OFFSET`, total global ni lecturas de toda la base. Las queries de reportes están acotadas a 50 órdenes * 20 partes + 1, y siguen protegidas por tenant RLS.

La selección del parte se hace determinista: si hay uno `verified`, se considera un posible cierre; si no, se selecciona el parte `submitted` más reciente según `created_at DESC, id DESC`. Los rechazos históricos se conservan en el detalle, sin bloquear la evaluación del parte corregido.

## Interfaz y resiliencia
Se conserva una pila de cursores del recorrido actual para retroceder sin `OFFSET`. **Actualizar pendientes** borra la pila y comienza una nueva lectura desde la primera página. Ante cambio de usuario, empresa, rol, modo mock/live o revisión del workspace se desmonta el componente anterior con `key` ligado a identidad, se cancelan actualizaciones React pendientes y se limpian los datos visibles. Una respuesta inválida, un cursor vencido o una red fallida no muestran órdenes anteriores como resultados reales; aparece error y botones de reintento/actualización.

La bandeja continúa siendo **orientativa**: no aprueba, no cierra, no prueba integridad de adjuntos y no descuenta stock. `Abrir orden` vuelve a usar el detalle autorizado del backend, y el endpoint de revisión verifica los requisitos bajo locks antes de aceptar. No se alteró ningún permiso ni política RLS.

## Pruebas y límites
- Unit backend: firma, integridad, identidad del usuario/tenant, límite TTL, ancla, último timestamp, selección determinista de parte.
- PostgreSQL/PostGIS HTTP real con dos empresas: consulta previa, página de 50, carga de 60 órdenes adicionales, nueva orden después de la página 1, página 2 sin duplicados ni orden nueva, reintento idéntico, usuario o tenant diferente => 422, firma alterada => 422; cambio de estado en página anterior no desplaza la siguiente; legacy `page` 422.
- Frontend: respuesta con cursor tipado, next_cursor nulo consistente, reset por refresh e identidad, back/forward y cancelación de consultas, sin aprobación client-side.
- CI exact SHA: backend/frontend/unit/build, PostgreSQL/PostGIS original y restaurada, FORCE RLS/backup+restore, Chromium y offline; merge normal solo verde, después CI postmerge.
- **Límite importante:** keyset más ancla estabiliza la **pertenencia/orden de páginas frente a altas posteriores**, pero no equivale a una transacción de snapshot extendida durante 15 minutos. Si una orden cambia de estado, deja de estar `in_progress` en una página futura; sus motivos de atención también pueden cambiar. No se informa una fotografía inmutable ni se generan estados falsos. Si se requiere un verdadero snapshot de datos, habría que persistir un identificador de consulta por usuario/tenant con retención y límites adicionales.
- No hubo migración, modificación de autenticación, credenciales, esquema de inventario, scouting, GIS, offline, CI, VPS, staging o despliegue productivo. QA física de campo/móvil pendiente.
