# SedeAgro 0.1 — Enrutamiento inequívoco de empresa

**Piloto:** empresa → roles → campo/lote → campaña → recorrida → evidencias → orden → reporte. **Riesgo:** petición HTTP con señales de tenant contradictorias antes de la autorización y selección del ámbito RLS.

## Problema concreto

`tenantResolver` priorizaba `Host` o `x-tenant-slug` para buscar la empresa, dejando en segundo plano `x-tenant-id`. Por ejemplo `x-tenant-id=A` y `x-tenant-slug=B` podía resolver B. Un JWT firmado para A sería rechazado posteriormente por `requireAuth`, pero un JWT válido para B aceptaría el enrutamiento pese a que la aplicación pidió explícitamente A. El host también podía contradecir el slug enviado.

## Contrato de protección

- En rutas con tenant requerido, si el host resuelve un slug y `x-tenant-slug` especifica otro, responder **400 TENANT_HINT_CONFLICT antes de consultar el tenant**.
- Si se proporcionó `x-tenant-id` además de un slug, después del `Tenant.findOne` comparar estrictamente el UUID con el ID resuelto; si no coincide, **400 TENANT_HINT_CONFLICT antes de asignar `req.tenant` o abrir la transacción RLS**.
- `x-tenant-id` no válido se rechaza con **400 TENANT_ID_INVALID** antes de cualquier consulta. Arrays u otros tipos no se consideran identificadores válidos.
- Una única señal válida sigue funcionando. Host + slug + UUID consistentes también; no cambia la firma ni la verificación de sesión y **ningún header otorga privilegios**. El JWT sigue vinculado a empresa por `requireAuth`.
- Login, registro y aceptación de invitaciones siguen rutas públicas globales y **no** usan el resolver; sus propios controles de autenticación/autorización continúan vigentes.

## Pruebas

`backend/test/tenantHintPolicy.test.js`: combinaciones de host, slug, UUID, entradas inválidas y orden correcto de las comprobaciones.

`backend/test/tenantHintConflict.pg.mjs`: PostGIS descartable, runtime non-owner, empresas A/B, usuario real únicamente en B, login y Bearer auténticos. Demuestra 200 con tenant B explícito y señales redundantes correctas, 400 para ID A+slug B y viceversa, 400 para Host A+slug B, 400 UUID inválido, 403 para token de B contra A, 200 posterior para tenant B sin filtración de contexto.

## Límites

El código no añade RLS a `memberships` (#232), no reemplaza autorización de rutas y no prueba certificación móvil offline. Staging y dispositivos físicos: `NOT_RUN`, release #130: **NO-GO**. Ningún deploy productivo.
