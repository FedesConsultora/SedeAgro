# 0T.12 — Insumos utilizados **declarados** por parte (no inventario)

## Diagnóstico del `main` anterior
Las tablas `agricultural_inputs` y `work_order_inputs` contenían catálogo y planificación; el parte `work_order_executions` 0T.9 no distinguía consumo planificado de cantidad efectivamente **informada**. Una ruta permitía incorporar insumos al plan incluso después de aprobar una orden. El checklist 0T.11 verificaba tiempo/superficie/operación/evidencia pero no exigía conciliar insumos planeados.

## Nuevo recorrido de campo
1. Coordinación registra en **borrador** o `pending_approval` las líneas previstas de insumos `POST /work-orders/:id/inputs`; el servidor exige catálogo del mismo tenant, bloquea el pedido si la orden ya fue aprobada/avanzó y conserva auditoría mínima. La aprobación congela la base de comparación.
2. Un operario autorizado inicia la orden, presenta un parte de ejecución como antes. Si tiene insumos previstos, **solo el autor de ese parte** ingresa para cada línea la cantidad **que declara haber utilizado**, en unidades propias del producto del catálogo. `0` es válido para declarar que no se usó. Puede explicar los desvíos; si un total planificado difiere, la explicación de al menos 10 caracteres es obligatoria.
3. El navegador y el backend distinguen cantidad prevista, informada y diferencia **informada menos prevista**, sin sumar kg con L. El servidor almacena una instantánea de nombre, unidad, plan/real informado y variación, ordenada y asociada al autor + momento. No recalcula cifras históricas tras cambios en el catálogo.
4. El registro es **inmutable**. Si se intenta modificar luego de enviar, responde 409. Un reintento exacto con el mismo UUID devuelve 200 aun después de aprobar/cerrar sin generar una segunda auditoría. Para corregir se debe rechazar el parte y crear una nueva declaración en un nuevo parte; no se borran datos históricos.
5. La revisión positiva de un parte con insumos planificados queda bloqueada hasta recibir su declaración; el checklist humano 0T.11 y la integridad de adjuntos permanecen obligatorios cuando correspondan. El rechazo con explicación sigue disponible aun sin declaración. Las órdenes sin insumos previstos mantienen su flujo normal.

**Nunca se descuentan existencias ni se presupone aplicación física.** Las cantidades son testimonios de un usuario autenticado: no constituyen telemetría, control de stock, comprobante fiscal, dosificación validada ni evidencia agronómica automatizada.

## API
- `POST /api/v1/work-orders/:id/executions/:executionId/input-declaration` — autenticación + tenant + entitlement `work_orders` + `orders.execute`. Requiere orden visible para el contratista, autor original, parte `submitted` y orden `in_progress`. Bloqueo transaccional de fila de orden serializa declaración, revisión y cierre.
- JSON estricto: `{"client_declaration_id":"<UUID>","notes":"Motivo del desvío","items":[{"work_order_input_id":"<UUID>","declared_quantity":"6.5000"}]}`. **Todos** los insumos previstos una sola vez; array de 0 a 25, cantidades decimales string sin exponentes, rango 0–99999999.9999 y precisión máxima cuatro decimales. Las identidades de empresa, catálogo, nombres, unidades, total previsto y diferencia **se derivan en el servidor**, no se aceptan del cliente.
- `201` primera declaración, `200` replay idéntico, `403` otro autor, `404` orden ajena/no asignada/parte ajeno, `409` cambio, orden cerrada o no revisión, `422` cantidades o referencias inválidas/duplicadas/desvíos sin nota. Respuesta `Cache-Control: private, no-store`.
- La declaración viaja en `WorkOrderExecutions[].input_declaration` dentro del detalle autorizado de la orden, junto a las declaraciones revisadas/rechazadas y el resto del historial (hasta 20).
- `POST /api/v1/work-orders/:id/inputs` sigue requiriendo `orders.write`; solo mientras `draft`/`pending_approval`, valida catálogo propio y audita creación. No inventa un movimiento de inventario.

## Migración y permisos
`202610160002_execution_input_declarations.js` agrega `work_order_executions.input_declaration jsonb`, con CHECK SQL de tipo/shape y array bounded. La tabla existente mantiene `tenant_id`, FORCE RLS, FKs de orden y autor. Los partes históricos quedan `NULL`: no se generan números ficticios. El rollback se detiene si existen declaraciones; preservar/exportar antes de intentar eliminar columna. No hay sistema de stock ni tablas de consumos reales alteradas.

## Tests y alcance del bloque
- Unit backend: cantidades exactas 4 decimales y signo de diferencia, dos unidades distintas, no plan/duplicados, explicación obligatoria, snapshot y replay.
- Unit frontend: roles/cuenta, order status, estructura y confirmación de respuesta, formulario y confirmación de revisión.
- PostgreSQL/PostGIS real (tenant A/B): plan interno y catálogo externo, congelamiento después de aprobar, author-only y capability, plan incompleto/duplicado, explicación de diferencias, UUID replay/concurrent-safe bajo row lock, aprobación prohibida sin cantidades, aceptación después del registro, cierre, historial privado, auditoría única. No se desactivó ningún control RLS.
- CI exact-head sobre PR + gate posmerge: backend/frontend, PostGIS original y restaurado, migraciones, backup/restore, Chromium cookies/offline y build.

## Límites y siguiente ampliación
No hay plan editable después de aprobar, corrección de cantidades en la misma declaración, carga offline automática, productos no previstos, rendimientos, registro de lote de producto, aplicación regulatoria ni integración con stock. Estos requieren contratos propios y aceptación de negocio. Siguiente bloque sugerido: desvíos operativos y justificación/protocolo de correcciones, conservando registros inmutables e independencia de revisores.
