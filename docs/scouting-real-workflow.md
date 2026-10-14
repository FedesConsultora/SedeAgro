# Bloque 0F — recorridas, observaciones y archivos reales

## Flujo operativo

El módulo de monitoreo trabaja con los endpoints existentes de campañas y recorridas, pero ya no confunde un registro de metadatos con un archivo almacenado.

1. Un `tenant_admin` o `agronomic_coordinator` crea una recorrida seleccionando un lote de campaña real (`GET /api/v1/campaigns/fields`). Se corrigió el orden de esa ruta antes de `/:id`.
2. Se puede asignar a un usuario con membresía activa del mismo tenant. El `scout` ve exclusivamente las recorridas asignadas a su ID, tanto en listados como al consultar detalles.
3. Al crear una observación, **el servidor deriva `field_id` del `campaign_field_id` de la recorrida**. Si un cliente antiguo envía otro lote, se rechaza (422). Las observaciones se permiten en estado `planned` o `in_progress`, y no después de completar o cancelar.
4. Desde la observación se puede seleccionar un archivo local; se envía su contenido en base64 y se confirma la escritura de `evidence_assets` y `evidence_blobs` en una sola transacción SQL.
5. El detalle de la recorrida consulta `GET /api/v1/scouting/runs/:id` y muestra las observaciones y evidencias que realmente se persistieron. La descarga requiere sesión, permiso `scouting.read` y acceso a la recorrida, y devuelve el contenido privado como base64, que la interfaz ofrece como descarga local.

## Contrato de evidencias

`POST /api/v1/scouting/observations/:observationId/evidence`:

```json
{
  "kind": "photo",
  "mime_type": "image/png",
  "original_name": "lote-norte.png",
  "content_base64": "<bytes del archivo codificados en base64>"
}
```

Solo se admiten: JPEG, PNG, WebP (`kind=photo`) y PDF (`kind=document`). Tamaño: entre 1 byte y **2 MiB**. Se verifica la firma inicial del archivo; esto **no reemplaza análisis antivirus ni decodificación exhaustiva del formato**. Los nombres con separadores de ruta, caracteres de control o longitud excesiva se rechazan. No se acepta `storage_key` ni URLs suministradas por el cliente; la API genera `db:<UUID>` internamente.

`GET /api/v1/scouting/evidence/:id/content` devuelve:

```json
{
  "data": {
    "id": "UUID",
    "original_name": "lote-norte.png",
    "mime_type": "image/png",
    "size_bytes": 1204,
    "content_base64": "<contenido real codificado>"
  }
}
```

Las respuestas llevan `Cache-Control: private, no-store`. Nunca se sirven archivos privados mediante rutas estáticas ni enlaces públicos. Los archivos existentes que solo tengan `storage_key` permanecen como **metadatos legados**: no se afirma que estén disponibles ni se fabrica su contenido. `GET /content` devuelve 404 si no existe un archivo almacenado en `evidence_blobs`.

## Almacenamiento transaccional

La migración `202610140003_evidence_blobs.js` crea `evidence_blobs` con `content bytea`, FK compuesta `(tenant_id, evidence_id)` a `evidence_assets`, `ON DELETE CASCADE`, `CHECK octet_length <= 2097152` y `FORCE ROW LEVEL SECURITY`. Un fallo SQL durante el guardado revierte **ambas** escrituras. La suite comprueba **30 tablas RLS**, incluyendo los blobs privados.

**Límite de MVP:** PostgreSQL `bytea` sirve para evidencias livianas, pero no para videos, audio largo ni lotes de archivos grandes. Antes de producción a escala se requiere S3/MinIO u otra solución de objetos con carga streaming, antivirus, cuotas por plan, retención, backups y URLs firmadas. La solución actual es deliberadamente acotada y evita depender de un servicio externo inexistente.

## Autorización y estados

`tenant_admin` y coordinador pueden planificar recorridas, añadir observaciones y registrar evidencias. `scout` puede observar y consultar **solo la recorrida asignada**, no cambiar responsables ni cerrar la recorrida. El servidor valida membresía activa del responsable y evita cambios a estados terminales.

Transiciones admitidas: `planned → in_progress → completed`, con `cancelled` desde `planned` o `in_progress`. No se permiten saltos al estado completado ni volver a abrir recorridas cerradas.

El sistema **todavía no** aplica permisos por lote a todos los módulos del monitoreador: sigue pendiente la autorización por recursos en campañas e informes.

## Interfaz y modo de datos

- La página de Monitoreo consulta cada detalle a demanda: presenta un estado cargando, error con reintento y archivos disponibles realmente.
- La creación de observaciones y evidencias no afirma éxito en modo demo. El formulario de archivos solo se habilita en modo backend.
- `EndpointWorkbench` ya no utiliza datos de muestra cuando una petición backend falla. Deja una lista vacía y muestra error/acción de reintento.
- **Queda pendiente** revisar otras pantallas particulares que puedan tener su propio fallback; este bloque no certifica que todo el frontend esté libre de mocks fuera del modo demostración.

## Validación

```bash
npm --workspace backend run test
npm --workspace backend run test:db
npm --workspace frontend run build
```

`test:db` requiere PostgreSQL/PostGIS migrado, seed global y las credenciales propietario/aplicación separadas en una base **desechable** terminada o identificada con `test`. Las pruebas agregadas cubren recorrido → observación → evidencia → descarga, separación de responsables, solicitudes cruzadas, campos inconsistentes, tipos de archivo falsos, estados cerrados y guardado de bytes reales.

Antes de desplegar al VPS, realizar copia consistente y aplicar el procedimiento de roles PostgreSQL de `docs/security/postgres-rls-runbook.md`. Este PR no despliega producción.
