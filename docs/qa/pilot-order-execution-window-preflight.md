# Piloto 0.1 — prevalidación del parte de ejecución de órdenes

**30/10/2026 · 0R/A · base main `1f62c65d908e24f7b84373c1484b8c891fb24a62` · NO-GO #130**

## Problema que sí existía

El backend ya rechazaba por `validExecutionWindow` las fechas anteriores a la aprobación, rangos invertidos y finalizaciones posteriores a cinco minutos de la hora de servidor. Su esquema también exige superficie finita entre 0,01 y 1.000.000 ha con hasta dos decimales y un resultado de 10 a 2.000 caracteres. Sin embargo, el formulario React enviaba valores convertidos sin comprobar esas condiciones de negocio antes del POST. Con red rural irregular, el operador esperaba una respuesta 422 que se podía evitar.

## Solución enfocada

- `buildExecutionDraft` valida el intervalo contra `order.approved_at`, normaliza ambas fechas locales como instantes ISO UTC, impide intervalos invertidos y rechaza finalizaciones futuras usando la misma tolerancia de cinco minutos que el backend.
- Rechaza aprobación inexistente, fechas inválidas, superficie vacía, NaN/infinito, valores fuera del rango y más de dos decimales. Recorta espacios del resultado y comprueba su longitud. Solo devuelve el payload mínimo admitido por `executionSchema`.
- `WorkOrderExecutionPanel` utiliza esta validación **antes** de `api.request` y muestra los errores en el aviso existente; no se abre un envío si el operador ya puede corregir el dato. Continúa mostrando que se trata de una declaración, no de certificación física.
- El servidor sigue siendo autoridad sobre hora efectiva, estado `in_progress`, aprobación, asignación, rol, tenant, integridad de evidencias, revisión y bloqueo de filas. Una hora errónea del dispositivo aún puede causar rechazo y requiere corregirla; no debe falsearse la hora de trabajo.
- Ningún cambio a API, migraciones, autenticación, PostGIS, offline, RLS, CI, despliegues ni secretos.

## Aceptación

`frontend/test/workOrderExecution.test.js` cubre rangos UTC con offset, límite inclusivo de cinco minutos, igualdad con fecha de aprobación, intervalos inválidos, números y precisión de superficie, resumen y la conexión preflight→POST. Se conserva el contrato `validatedExecutionResponse`: ningún mensaje de éxito depende solo de pasar las validaciones de navegador.

**Ejecución en CI (no atribuir hasta comprobar el run exacto):** `node --test frontend/test/workOrderExecution.test.js`, frontend completo, build y gates de PR/MAIN. Estas pruebas de frontend no suplantan las pruebas PG ya existentes. La aceptación física Android Chrome/iOS Safari, firma de Product/Security y despliegue staging están pendientes y no se realizan aquí.

## Rollback

Revertir exclusivamente esta PR mediante un nuevo commit conservando el contrato del servidor. El cambio no crea datos persistidos ni requiere migración inversa.
