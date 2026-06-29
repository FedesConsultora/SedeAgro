# SedeAgro

SedeAgro es un SaaS AgTech multi-tenant para gestionar establecimientos, lotes, campañas, monitoreos, evidencias, órdenes de trabajo, equipos, activos, insumos, imagery y reportes. Este MVP deja lista la base técnica para crecer sobre PostgreSQL/PostGIS, backend Node.js y frontend React con Sass.

## Stack

| Capa | Tecnología |
| --- | --- |
| Frontend | React + Vite + Sass |
| Backend | Node.js + Express + Sequelize |
| Base de datos | PostgreSQL + PostGIS |
| Cache / cola futura | Redis |
| Infra | Docker Compose |

## Estructura

```text
SedeAgro/
├─ backend/
│  ├─ db/migrations/       # Extensiones, esquema, constraints, RLS
│  ├─ db/seeders/          # Catálogos globales, planes, roles y módulos
│  └─ src/
│     ├─ core/             # DB, tenant context, logger
│     ├─ infra/            # HTTP middlewares, migrator, raw SQL guard
│     ├─ models/
│     │  ├─ definitions/   # Un archivo por tabla
│     │  ├─ associations.js
│     │  └─ index.js       # Registry de modelos
│     └─ modules/          # Auth, GIS, campañas, monitoreo, órdenes, reportes, sync
├─ frontend/
│  └─ src/
│     ├─ components/
│     ├─ context/
│     ├─ pages/
│     ├─ services/
│     └─ styles/           # Sass con @use, variables y sass:color
├─ docker-compose.dev.yml
├─ docker-compose.yml
├─ dev.sh
└─ scripts/deploy-prod.sh
```

## Decisiones de arquitectura

- Multi-tenant desde el día cero con shared database y `tenant_id` en toda tabla de negocio.
- Roles por membresía: un usuario puede ser admin en un tenant y viewer en otro.
- Entitlements por plan y overrides mediante `tenant_modules`.
- PostGIS para polígonos de lotes, puntos de monitoreo y futuras capas.
- RLS activado en tablas de negocio con `SET LOCAL app.current_tenant` por request.
- SQL crudo bloqueado fuera de `queryTenant()` mediante auditoría.
- Modelos en archivos individuales por tabla; asociaciones separadas del registry.
- API versionada: `/api/v1` es el contrato recomendado y `/api` queda como alias.
- Estructura offline-first inicial con `sync_batches` y `sync_operations`.
- Entidades preparadas para maquinaria, insumos, reportes automáticos, notificaciones e imagery.
- Logging estructurado con redacción de secretos y SQL logging apagado por defecto.
- Respuestas de error con `code`, `message` y `request_id` para soporte.
- Frontend con loader global, toast de errores y error boundary.
- Frontend con modo `Mock` / `Backend` para probar endpoints sin perder datos demo.
- Sass usa `@use` y `sass:color`; `@import`, `darken()` y `lighten()` quedan bloqueados por script.

## Alcance del MVP

El modelo cubre las entidades mínimas definidas en el documento estratégico:

| Área | Tablas principales |
| --- | --- |
| SaaS core | `tenants`, `plans`, `memberships`, `tenant_modules`, `tenant_integrations` |
| Organización | `users`, `roles`, `permissions`, `teams`, `team_members`, `notifications` |
| GIS | `producers`, `farms`, `fields` |
| Campañas | `crop_types`, `crop_varieties`, `campaigns`, `campaign_fields` |
| Monitoreo | `scouting_runs`, `scouting_observations`, `evidence_assets` |
| Ejecución | `work_orders`, `work_order_assignees`, `work_order_inputs`, `work_order_machinery` |
| Recursos agro | `machinery`, `agricultural_inputs`, `rainfall_events`, `irrigation_events` |
| Imagery | `satellite_layers` |
| Reportes | `report_templates`, `report_runs` |
| Offline / auditoría | `sync_batches`, `sync_operations`, `audit_events` |

## Endpoints principales

Usar preferentemente `/api/v1`; `/api` existe como alias.

| Módulo | Rutas |
| --- | --- |
| Auth | `POST /auth/register-tenant`, `POST /auth/login`, `GET /auth/me` |
| GIS | `/farms`, `/farms/producers`, `/fields`, `/fields/:id/rainfall`, `/fields/:id/irrigation` |
| Campañas | `/campaigns`, `/campaigns/:campaignId/fields` |
| Monitoreo | `/scouting/runs`, `/scouting/runs/:runId/observations`, `/scouting/observations/:id/evidence` |
| Órdenes | `/work-orders`, `/work-orders/:id/assignees`, `/work-orders/:id/inputs`, `/work-orders/:id/machinery` |
| Equipos | `/teams`, `/teams/:id/members` |
| Activos | `/assets/machinery`, `/assets/inputs` |
| Imagery | `/imagery/layers` |
| Reportes | `/reports/templates`, `/reports/runs` |
| Offline | `/sync/batches` |
| Notificaciones | `/notifications`, `/notifications/:id/read` |

## Desarrollo

1. Copiar variables:

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

2. Levantar el entorno:

```bash
./dev.sh
```

El script levanta PostgreSQL/PostGIS, Redis y backend en Docker, ejecuta migraciones y seeders, y arranca el frontend localmente si `npm` está disponible.

## Probar endpoints desde el frontend

El botón de conexión del encabezado permite alternar entre `Mock` y `Backend`.

- `Mock`: usa datos locales relacionados entre sí para diseñar y navegar sin token.
- `Backend`: usa `VITE_API_URL` o `http://localhost:3001/api/v1`, enviando `Authorization` y `x-tenant-id`.
- Cada módulo tiene tablas, estado de origen, botón de refresco y formulario de alta con el payload esperado por el endpoint.
- Si el backend falla, la pantalla vuelve a datos mock y el toast muestra el error con `request_id` cuando existe.

## Primer tenant

Después de levantar el backend, crear una organización:

```bash
curl -X POST http://localhost:3001/api/v1/auth/register-tenant \
  -H "content-type: application/json" \
  -d '{
    "organizationName": "Demo Agro",
    "slug": "demo-agro",
    "fullName": "Admin Demo",
    "email": "admin@sedeagro.local",
    "password": "CampoSeguro2026"
  }'
```

La respuesta devuelve `token`, `tenant.id` y `entitlements`. Para llamadas protegidas usar:

```bash
Authorization: Bearer <token>
x-tenant-id: <tenant.id>
```

## Producción

1. Completar `backend/.env` con secretos reales.
2. En el VPS:

```bash
./scripts/deploy-prod.sh
```

El script actualiza `main`, reconstruye contenedores, aplica migraciones y seeders, y recarga `fedes-proxy` si existe.

## Auditorías

```bash
npm run audit
```

Incluye:

- Sass sin `@import`, `darken()` ni `lighten()`.
- Backend sin `sequelize.query()` directo fuera de helpers permitidos.

## Logging y errores

Variables relevantes:

```env
LOG_LEVEL=info
LOG_SQL=0
LOG_STACK=0
CORS_ORIGIN=https://sedeagro.example.com
```

- `LOG_SQL=0` es el valor recomendado. Si se activa, sólo se loguea un resumen truncado de la query.
- Campos sensibles como `password`, `token`, `authorization`, `cookie`, `secret` y `credentials` se redactan.
- En producción, los stacks no se devuelven ni se loguean salvo que se habilite expresamente fuera de producción.
- El frontend muestra errores usando el `request_id`, para poder correlacionar con logs del backend.

## Pendientes conscientes

- La app móvil offline-first todavía no está implementada, pero el backend ya tiene el contrato inicial de sincronización.
- Los reportes todavía quedan en estado `queued`; falta worker de generación PDF/XLSX.
- Las capas satelitales guardan metadata y `storage_key`; falta pipeline Sentinel/Landsat o proveedor premium.
