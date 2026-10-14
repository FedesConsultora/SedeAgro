# 0S.6 — Recuperación guiada de una fotografía offline parcialmente sincronizada

Cuando **Sincronizaciones → Conciliar observaciones** reconoce un `SyncBatch` aplicado en PostgreSQL con una observación confirmada, pero la fotografía del borrador cifrado no tiene acuse de carga, aparece **Reintentar solo fotografía**.

## Recuperación segura

1. El operador con su cuenta y empresa actuales elige el borrador y confirma explícitamente la acción. No existe acción automática nueva, ni se intenta mientras `navigator.onLine === false`.
2. La interfaz vuelve a consultar `GET /api/v1/sync/my-batches`; no utiliza el listado de otros usuarios. Exige **un solo** recibo `processed` con misma clave de idempotencia, `client_id`, actor, entidad `scouting_observation`, operación `create`, `entity_client_id`, recorrida y `observation_id`.
3. El motor relee la entrada IndexedDB actual de ese usuario/tenant bajo el mismo `navigator.locks` por scope que usa `flush`, verifica de nuevo el recibo y examina la fotografía **original** ya guardada. Su `client_upload_id` debe ser UUID válido y el contenido debe conservar firma MIME/tamaño limitado a 512 KiB.
4. Se envía **únicamente** `POST /scouting/observations/:id/evidence`, con los **mismos bytes y `client_upload_id`** de la foto original. No se reenvía el lote de observación, no se crea una observación nueva y no se modifican GPS/notas.
5. Se retira la copia cifrada local **solo si** la respuesta incluye el activo de evidencia `id` UUID, `scouting_observation_id`, `client_upload_id`, `uploaded_by`, tipo, MIME, nombre y `size_bytes` exactos. El backend retorna 201 nueva o 200 `replayed:true` para la misma carga idempotente, sin duplicar contenido.
6. Si se pierde la respuesta, la conexión, la autorización (401), hay conflicto (409), respuesta incompleta o el registro local cambió durante la operación: la foto no se elimina, se preservan los identificadores y bytes originales y se indica el resultado para revisión o reintento. Ningún error externo se interpreta como ausencia de carga en servidor.
7. Si otra pestaña ya está enviando, se retorna un estado ocupado, sin duplicar el POST. Si el usuario borró el borrador durante la petición, jamás se recrea. La API vuelve a comprobar la autorización y RLS para el actor; un UUID por sí solo no concede acceso.

## Límites

La vista muestra únicamente los **100 recibos personales más recientes**. Si el recibo aplicado no aparece, el sistema **no permite esta recuperación abreviada**: se conserva el borrador y sigue disponible el mecanismo idempotente general (que reenvía la operación original con la misma clave). Sin foto guardada, firma válida o confirmación independiente, tampoco se elimina ningún dato.

La foto del borrador se mantiene cifrada con AES-256-GCM por tenant/usuario. No se almacena copia nueva en localStorage y no se genera una segunda clave de carga.

## Verificación y piloto

```bash
npm --workspace frontend run test
npm --workspace frontend run build
# GitHub Actions postgres-isolation.yml: PostgreSQL RLS + Chromium offline
```

Los tests cubren 201 y replay 200, comprobación de todos los metadatos, fallas de red, 401/409, recibos ajenos/parciales, bytes alterados, offline, doble pestaña, eliminación simultánea y reutilización de `client_upload_id`.

**Falta aceptación física** en iPhone/Android con cambio de red, pérdida de ACK justo después del commit, una cuenta reasignada, pestañas múltiples y almacenamiento bajo presión antes de considerar el módulo listo para piloto. No se despliega producción en este bloque.
