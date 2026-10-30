# SedeAgro 0.1 — Reconciliación de revisiones cuando falta el ACK HTTP

**Alcance:** carril de órdenes del piloto, módulo de partes y revisión independiente. Base: `150d89d401dbaea17d488b849adc353510bc914b`. No se modifican RLS, servidor, migraciones, políticas de sesión ni infraestructura.

## Problema observable

`POST /work-orders/:id/executions/:executionId/review` actualiza la fila del parte y genera un evento de auditoría dentro de la transacción. Si la conexión se corta DESPUÉS de ese COMMIT y ANTES de llegar el HTTP 200, el navegador no puede concluir que el POST falló. Mostrar simplemente un error sin bloquear la reejecución invita a una segunda decisión (409 por parte ya revisado), aumenta las dudas operativas y no aclara quién revisó el parte.

## Contrato implementado

1. La interfaz solo intenta una revisión explícita, con autorización y checklist o motivo ya validados. Nunca reenvía el POST por su cuenta.
2. Ante error de transporte, respuesta 5xx o los conflictos específicos `EXECUTION_ALREADY_REVIEWED`/`EXECUTION_REVIEW_CLOSED`, conserva temporalmente la decisión presentada, bloquea ambos botones y solicita `GET /work-orders/:id` bajo la sesión autorizada actual.
3. Solo puede declarar revisión registrada si coinciden exactamente el ID de orden, ID de parte, ID de revisor, decisión, fecha de revisión válida y checklist estructurado (cinco campos) **o** motivo exacto de rechazo. El hecho de que un parte figure `verified` por otro usuario NO acredita esta petición.
4. Si el GET devuelve `submitted`, historial incompleto/ambiguo, revisión distinta o error de sesión, la UI **no** declara éxito. Permite una nueva lectura manual sin repetir POST; actualizar datos requiere volver a consultar al servidor.
5. Una revisión administrativa `verified` no es certificación física ni garantía de haber realizado una aplicación. El posterior cierre de la orden sigue sujeto al backend y a un parte verificado.

## Cobertura introducida

`frontend/test/workOrderReviewReceipt.test.js` comprueba respuestas inciertas vs errores definitivos, reviewer incorrecto, decisiones distintas, checklist incompleto, motivo de rechazo distinto, historial manipulado/duplicado/ausente y contrato UI para impedir reenvíos.

### Verificación reproducible

```bash
node --test frontend/test/workOrderReviewReceipt.test.js
node --test frontend/test/reviewChecklist.test.js frontend/test/workOrderExecution.test.js frontend/test/workOrderExecutionReceipt.test.js
npm run test --workspace @sedeagro/frontend
npm run build --workspace @sedeagro/frontend
```

CI exact-HEAD y main independiente se documentan únicamente cuando GitHub confirme sus resultados. No se pudieron ejecutar localmente en el entorno de herramienta GitHub conectado (sin checkout/DB/Chromium). Los checks reales del PR deben verificar que el resto del circuito no se degrade.

### Aceptación operacional pendiente

Con PostgreSQL descartable, usuario ejecutor real y revisor distinto con capacidad `orders.write`: presentar parte, verificar evidencias/insumos necesarios, interceptar SOLO el ACK de `POST /review` DESPUÉS del COMMIT, verificar un único evento `work_order.execution_reviewed`, GET autenticado y comprobación exacta de decisión y revisor. Repetir para rechazo con motivo, y para cambio de rol/tenant durante la recuperación. Sin entorno físico esto es protocolo de aceptación pendiente, no prueba ejecutada.

**Limitaciones y rollback:** el POST de revisión no posee una llave idempotente duradera. El bloqueo temporal vive en el componente y no es una garantía multitab/recarga: el backend es autoridad, por lo que operadores no deben reenviar manualmente una revisión incierta sin consultar la orden. Para revertir esta mejora visual, revertir los commits de este PR sin tocar los datos o la auditoría persistidos. No se desplegó a staging ni producción; iOS/Android, Security Owner y Product Owner siguen pendientes; release #130 continúa **NO-GO**.
