# 0T.25 — Búsqueda global de títulos en órdenes de coordinación

## Alcance funcional
El coordinador puede escribir una frase y pulsar **Buscar órdenes** para consultar TODOS los títulos de órdenes `in_progress` autorizadas, no solo los resultados de la página actual. La consulta utiliza el valor exclusivo de `work_orders.title`: **no consulta instrucciones, campos privados, partes, evidencias, insumos, productores ni usuarios**. Se combina con los filtros SQL globales de tipo, estado de revisión, prioridad y ventana de vencimiento. Mantiene `created_at DESC,id DESC`, paginación keyset anclada a la primera página y hasta 50 filas de respuesta; no hay ranking por relevancia ni totales globales inventados.

La búsqueda implementa subcadena literal **sin distinción de mayúsculas/minúsculas** mediante `strpos(lower(title),lower(query))>0` y parámetros escapados por Sequelize como valores SQL (nunca concatenación SQL). No se instalan extensiones, `unaccent`, trigram ni búsqueda libre por texto completo: las tildes siguen siendo significativas; `%`, `_`, apóstrofes y operadores no son comodines ni sintaxis de SQL. El contrato no promete búsquedas por sinónimos ni coincidencias semánticas.

## Validación y cursor
- `GET /api/v1/work-orders/review-queue?q=Riego%20urgente`: `q` opcional; si falta, corresponde al listado completo. Si se especifica vacío, array, duplicado, carácter de control, longitud menor que 2 o superior a 64 puntos de código Unicode, se devuelve HTTP 422.
- La frase se normaliza con Unicode NFC, recorte exterior y colapso de espacios Unicode en un solo espacio. Una frase con espaciado distinto obtiene un valor canónico único.
- El cursor HMAC **v6**, TTL 15 minutos, firma `tenant,user,workType,reviewState,priority,dueWindow,titleQuery,anchor,expires,lastTuple`. El cursor de otro texto/cualquier filtro/tenant/usuario, un token v5 o modificado se rechaza con 422; el cliente ofrece iniciar otra consulta. El cursor no es credencial de acceso.
- RLS FORCED, entitlement, capacidad y rol se comprueban en cada petición. El detalle revalida autorización y datos actuales, sin mutaciones ni aprobaciones automáticas.

## Experiencia web y accesibilidad
Hay un campo etiquetado `Buscar por título (todas las páginas)` con rol de búsqueda, un botón **Buscar órdenes** y otro **Limpiar búsqueda**. No se solicita a la API por pulsación de tecla; Enter o Buscar confirman el nuevo texto. Una frase inválida produce un aviso de formulario sin reemplazar resultados previos; limpiar restablece la búsqueda sin borrar criterios de tipo/estado/prioridad/vencimiento. Cuando cambia el criterio confirmado, se eliminan cursores, vuelve a página 1 y cambia la `requestKey`, abortando y descartando respuestas tardías. Foco visible y elementos táctiles mínimo 44 px.

No se muestran resultados de otro tenant, ni contenido privado ni un supuesto total de todas las órdenes. Al navegar y actualizar se mantiene la frase confirmada; el borrador no se ejecuta automáticamente.

## QA exigido y evidencia
- Backend unitario: canonización NFC/whitespace, control chars, límites, `%/_` literales, cursor v6 cross-query, HMAC y aislamiento.
- PostgreSQL/PostGIS: orden por título y filtros compuestos, rol contratista 403, segundo tenant aislado, texto en mayúsculas/minúsculas, símbolos `%/_` y apostrofes no ejecutables, listas/duplicados y valores inválidos 422.
- Chromium real: 61 órdenes *Real review browser* antiguas y 55 *Global application* nuevas, búsqueda global del título antiguo 50/11 pese a que las más recientes no coinciden; búsqueda combinada 50/5, cursor firmado cambiado de frase obtiene HTTP 422 real; frase literal `%_` sin coincidencias; error corto preserva consulta previa, limpiar/restablecer conserva filtros y el segundo tenant queda sin datos.
- CI exacto del PR y CI independiente del merge en `main`, jobs `tenant-rls` y `browser-offline`, base original/restaurada PostGIS, FORCE RLS/backup, y Chromium. Un gate verde del PR no certifica posmerge, rendimiento, publicación ni campo.

## Coordinación con otros carriles
Revisión de reservas, HEAD, PRs y cierres en [issue #18](https://github.com/FedesConsultora/SedeAgro/issues/18). El carril #105 sigue reservado para **proponer y medir** optimizaciones con EXPLAIN ANALYZE BUFFERS, p50/p95 y pruebas de escala de la búsqueda (subcadenas `strpos(lower(title),...)` podrían requerir indexación u otra estrategia con tablas grandes). No inventar benchmarks, no introducir índices/migraciones sin evidencia ni PR separado. Otro trabajo, #86, sigue siendo el QA longitudinal de foco y lectores de pantalla. Un issue o handoff no ejecuta otro agente automáticamente.

No se modifican RLS, auth, esquema, índices, notificaciones, GIS, stock, offline, infraestructura, despliegue staging/VPS/producción ni permisos de aprobación. Rollback coordinado del contrato HMAC v6, API y UI con revert de los commits del bloque.
