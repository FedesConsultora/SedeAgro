# Piloto SedeAgro 0.1 — reconciliación del parte ante ACK perdido

**30 de octubre de 2026 · 0R/A · #166 · base main `bb3d13f4f1748203f59596e2db454032f7288fbe`**

## Defecto operativo cubierto

El `POST /work-orders/:id/executions` confirma una declaración y su auditoría en una transacción PostgreSQL. A diferencia del alta de campaña/recorrida/orden, **este endpoint NO posee un `client_request_id` duradero para replays idempotentes**. Si el servidor confirma 201 pero el navegador pierde la respuesta, la antigua UI decía «No se guardó el parte» e invitaba a repetirlo. El backend evita dos partes activos y retorna `409 EXECUTION_ALREADY_SUBMITTED`, pero la incertidumbre del operador podía persistir en el terreno.

## Comportamiento nuevo

1. El operador prepara fechas/área/resultado y autoría. `buildExecutionDraft` sigue validando contra la aprobación de la orden y normalizando instantes UTC **antes** del primer POST.
2. Si se recibe `201` válido, se respeta `validatedExecutionResponse` y se actualiza el detalle.
3. Si se pierde la respuesta HTTP, la API no devuelve un JSON válido, o llega el conflicto esperado `409 EXECUTION_ALREADY_SUBMITTED`, la UI **no reenvía el POST**. Bloquea el botón para ese intento y pide `GET /work-orders/:id` con la sesión/cookie actual y el servidor como autoridad.
4. La coincidencia exige la **misma orden, mismo usuario autor, mismo intervalo en instantes UTC, mismos dos decimales de hectáreas y mismo resultado**. Si hay exactamente un parte coincidente en el historial, se refresca la orden y se muestra la fila persistida. Se comunica que el servidor registra un parte coincidente, no que se comprobó causalmente ese ACK específico.
5. Si existe un parte ajeno o distinto, el historial es ambiguo, faltan permisos, el servidor es inaccesible o el servidor aún no devuelve el parte, **no se declara éxito**. El operador puede volver a consultar el servidor sin repetir el POST. Una recarga completa posterior permite consultar el estado del recurso, nunca se hace retry automático de una mutación no idempotente.
6. Errores explícitos 401/403/404/422 y conflictos ajenos no se maquillan como envío incierto; el backend mantiene sus rechazos y revocaciones.

## Aceptación automatizada

- `frontend/test/workOrderExecutionReceipt.test.js`: serialización DECIMAL PostgreSQL, diferentes offsets equivalentes, identidad ajena, variaciones del payload, historial truncado/inválido, múltiples coincidencias, 409 específico y no reintento.
- `scripts/acceptance-browser-review-inbox.mjs`: crea una orden real en la misma empresa de prueba; completa el formulario React autenticado; Playwright ejecuta `route.fetch()` hasta obtener `201` real de Express/PostGIS y **descarta solamente el ACK de respuesta** al navegador. El cliente reconcilia con `GET` autorizado. SQL comprueba exactamente un parte y un evento `work_order.execution_submitted`, con un solo POST emitido.
- La suite existente de roles, RLS FORCE, revisiones/checklist, CSV/PDF/XLSX y CI permanece intacta.

## Límites y seguridad

Esta es **reconciliación con lectura autoritativa**, no idempotencia duradera del POST ni prueba física de ejecución. Dos declaraciones históricas indistinguibles no acreditan el ACK original. Sin conexión, la UI permanece en incertidumbre; no desbloquea el envío por una observación local. La lectura falla cerrada cuando otra sesión/tenant no está autorizado. No se guardan partes ni contraseñas en localStorage y no se cambian sesión, cookies, RLS, migraciones, esquemas ni permisos.

**Gates pendientes de ejecución hasta verificar GitHub:** cinco jobs de PR en HEAD exacto, luego siete jobs independientes de main. Staging, Seguridad/Producto, Android/iOS físicos y certificación en lote NO ejecutados. El release #130 sigue **NO-GO**.

## Rollback

Revertir únicamente esta PR y revalidar las suites. No hay migración ni eliminación de registros. El código anterior no debe reutilizarse como autorización para reenvío ciego.
