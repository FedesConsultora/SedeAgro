# SedeAgro 0.1 · Observación → orden → ejecución/revisión → reporte verificable

**2026-11-03 · Bloques 0R.3 (PR #287) y 0R.4 · coordinación #18, aceptación #166; release #130 NO-GO.**

## Flujo completo

1. Un administrador o coordinador con `scouting`, `gis`, `work_orders` activos abre una observación auténtica de una recorrida de su empresa. La acción de preparar una orden es inexistente en demo, productor, scout y contratista.
2. Una navegación **solo en memoria React** precompleta lote, lote de campaña, tipo `inspection`, prioridad según severidad y una nota de verificación. No transporta observaciones completas, GPS, EXIF, fotos ni bytes privados. El lote original no puede cambiarse desde ese borrador.
3. El operador revisa el texto, fecha y prioridad y hace un clic explícito en **Crear orden**; nunca se prescribe una aplicación o dosis automática. El envío incluye `origin_observation_id` además de `field_id`, `campaign_field_id` y `client_request_id`.
4. El servidor verifica `orders.write`, `scouting.read`, módulos habilitados, tenant y la existencia exacta de esa observación. Compara el lote de la observación con el de la orden y la campaña de su recorrida con `campaign_field_id`. Solo si todo coincide crea la orden **`draft`** y su vinculación en una única transacción de PostgreSQL con FORCE RLS.
5. El backend conserva las transiciones normales de aprobación, asignación, parte de ejecución, revisión independiente y cierre. La identidad del origen **no otorga permisos** para consultar la recorrida. En el detalle de orden solo admin/coordinador con acceso vigente a scouting ve IDs de observación/recorrida y un botón de navegación que vuelve a consultar al backend.
6. En el reporte privado por lote para `reports.read`, el mismo snapshot limitado a 200 filas por clase enlaza las órdenes consultadas con su procedencia persistida: columnas `observacion_origen_id`, `recorrida_origen_id` en CSV/XLSX y línea de origen en PDF. Órdenes anteriores sin procedencia tienen celdas vacías, **nunca un origen inventado** por analizar texto.

## Esquema y pruebas de integridad

Migración aditiva `202611030001_work_order_observation_origins.js` crea `work_order_observation_origins` con una relación como máximo por `(tenant_id,work_order_id)`, `scouting_observation_id`, `scouting_run_id`, `field_id`, `campaign_field_id`, `created_by`, fecha y RLS FORCE. **No se agregó una FK directa a `work_orders`**: la relación se materializa en esta nueva tabla. Tres FKs compuestas comprueban simultáneamente `(tenant,orden,lote,campaña)`, `(tenant,observación,recorrida,lote)` y `(tenant,recorrida,campaña)`. No se puede cambiar por SQL el lote/campaña de una orden ya vinculada sin violar la FK. Se prohíbe la eliminación de observaciones/recorridas vinculadas sin intervención de mantenimiento. No se mezclan notas, fotos, geometrías ni contenidos de evidencia.

La autorización se verifica **antes incluso del replay idempotente**. `client_request_id` + cuerpo original solo puede reutilizarse bajo el mismo actor y tenant; cambiar el `origin_observation_id` hace variar la huella y termina en conflicto, sin asociar otra observación. **Compatibilidad:** la huella para POST históricos que NO contenían origen conserva el byte-for-byte canónico previo y sus recibos anteriores siguen siendo válidos. La copia AES-GCM del POST original, incluido el origen, se guarda antes de la red, sobrevive recarga y se retira solo después de un 2xx íntegro. Nunca existe reenvío automático ni credenciales en IndexedDB.

## Aceptación y límites

- Backend unitario: huella SHA-256 histórica y nueva, contrato de migración y ausencia de campos privados.
- PostgreSQL no-owner + Express real: caso completo observación GPS/foto privada → orden con FK → parte, revisión independiente, cierre → CSV/PDF/XLSX; replay misma clave, contrato de detalle por rol y negativa de acceso entre empresas. Negativas por observación extranjera y por lote/campaña incoherente. Verificación SQL de una sola relación y RLS para tenants A/B.
- Chromium autenticado real: iniciar desde la observación persistida, guardar orden explícita, comprobar `observation_origin` del servidor y la única fila de origen SQL, abrir detalle, navegar de vuelta a recorrida autorizada y continuar todos los tests de evidencia, revocaciones y aislamiento.
- No cambia autorización del contratista ni se descargan fotos a Reportes. Un UUID de origen en un reporte es una referencia de auditoría, no permiso de lectura.
- La API de reportes **no** prueba intervención profesional ni eficacia agronómica, solo cadena de IDs, estado y registro. Las órdenes de origen creado antes de 0R.4 **no se backfillean por texto**; su vínculo solo existirá si fueron creadas con `origin_observation_id` bajo la nueva API.
- **Rollback:** revertir código/frontend no borra órdenes ni recibos; la migración `down` se niega si ya existen vínculos, de manera que un rollback productivo requiere decisión explícita con preservación de datos. Sin acceso a VPS, staging, secretos o producción en este bloque.
- CI PostgreSQL/Chromium/Linux no sustituye Android Chrome/iOS Safari reales, staging autorizado, firma Product/Security. La decisión del piloto #130 permanece **NO-GO** hasta certificar esos prerrequisitos.
