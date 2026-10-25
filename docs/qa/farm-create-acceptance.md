# 0U piloto — Alta verificable de establecimiento con productor autorizado

**Base:** `main@1224b938349da4e332757e9fcca3a1acea3e39b1`. Coordinación #18, matriz E2E #166 y release #130 **NO-GO**.

## Defecto observado

`FarmFormModal` usaba el estado React `saving` para impedir un doble POST de `/farms`: dos clics antes del siguiente render podían enviar dos peticiones. Ante cualquier promesa resuelta invocaba `onCreated()` sin validar UUID, empresa, productor ni metadatos del establecimiento. El fetch de productores dependía de la cancelación del efecto, pero la lista y el formulario no se ocultaban sincrónicamente al cambiar actor/empresa o el contexto de API. En modo demo se llamaba al callback con ID temporal como si se hubiera guardado el recurso.

## Contrato real del backend

La ruta `POST /farms` exige `gis.write`, scope tenant + transacción RLS y productor existente dentro de la misma empresa. Tiene mecanismo de replay idempotente por **(tenant, nombre)**: `Farm.findOrCreate()` devuelve `201 replayed:false` al crear o `200 replayed:true` con la misma fila si todos los campos coinciden. Si otro payload intenta reutilizar el nombre devuelve **409 FARM_CREATE_CONFLICT**. No se agrega un identificador de reintento al servidor.

## Implementado

- `farmCreateScope` exige sesión live autenticada, usuario/tenant actual, rol administrador o coordinador y módulo GIS. La verificación de permisos real continúa en Express.
- El listado de productores se obtiene sólo del backend live. Se valida la respuesta, se guarda con un snapshot vinculado a scope + identidad API y se oculta inmediatamente ante cambio de cuenta. Error de GET ofrece reintento sin permitir seleccionar productores del tenant anterior.
- `prepareFarmCreate` normaliza el nombre (2–180), localidad/provincia (140), país (80) y notas; valida que el productor elegido pertenezca al listado consultado bajo el scope actual, incluso cuando su referencia aparece sin `tenant_id` por proyección del servidor.
- Antes del primer `await`, una barrera síncrona impide doble POST. `verifyCreatedFarm` sólo da por válida una fila UUID con tenant, nombre, productor y geografía exactos, más `replayed` booleano.
- Tras HTTP incierto el operador puede pulsar **Reintentar el mismo envío**. Se usa el **mismo objeto congelado de payload**, misma sesión/API y mismo nombre; el backend confirma la misma fila o rechaza un conflicto real. No se hace un reintento silencioso.
- Modal X, Cancelar, Escape y overlay no cierran durante POST. Un ACK antiguo no puede completar el formulario de un actor nuevo. El modo demo no afirma persistencia.

## Pruebas y límites

`frontend/test/farmCreateSafety.test.js` incluye validación de scope y empresa, productor ajeno, catálogo inconsistente, límites de texto, ACK falso, payload opcional, doble clic, reintento exacto y descarte de ticket obsoleto. CI 4/4 necesario sobre SHA exacto, con PostgreSQL/Chromium, auditoría de seguridad y producción de imágenes.

**Aceptación manual pendiente:** en staging autorizado registrar establecimiento con productor y sin productor; forzar error GET de productores, cambiar de empresa durante carga, reproducir doble clic y timeout después del commit, verificar una única fila al reintentar con el mismo payload y comprobar 409 ante cambio posterior de productor/metadatos; validar dispositivo Android/iOS real. **NOT_RUN** en staging y teléfonos.

**Limitación:** el mecanismo server-side usa tenant + nombre como identidad de replay; si hay una operación diferente con el mismo nombre no la reescribe. Tras cerrar navegador o cambiar de usuario el formulario no recuerda su payload; no permite deshacer un alta confirmada. No hay cambios en migraciones, RLS, sesiones, cola offline, DNS o producción. Release #130 sigue NO-GO.
