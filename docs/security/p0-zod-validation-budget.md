# P0 Zod validation graph budget — defensa temporal (#210)

**Base:** `main@6a5ade8dae88376aeee2e2f002d266d29afe29f4`; sin lockfiles, CI, schema SQL, roles o despliegue. Release #130: **NO-GO**.

## Problema

La versión `zod@3.25.76` del backend aparece en el advisory HIGH [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). Es posible acumular errores de validación en muchos elementos inválidos aun si una estructura está acotada por `.max()`, según la versión y el orden de procesamiento. Express ya limita la entrada HTTP a **10mb**, pero esa barrera de bytes no acota suficientemente la cantidad de elementos pequeños que Zod analiza.

## Protección que implementa

`backend/src/utils/http.js` añade `withinValidationBudget` aplicado por `validate(schema, source)` **antes** de `schema.safeParse`. Realiza un recorrido iterativo (sin recursión) de los nodos JSON y permite como máximo **4.096 nodos totales**, incluyendo escalares, miembros de arrays y claves/valores de objetos. Rechaza estructuras excesivas con **HTTP 413, `VALIDATION_BUDGET_EXCEEDED`**, antes de acumular errores de Zod. Detecta ciclos o referencias compartidas programáticas no representables en JSON y las rechaza. La cuenta del presupuesto incluye nodos pendientes antes de expandirlos; un array grande se descarta sin apilar cada miembro.

El contenido de texto de un nodo no afecta el conteo, por lo que una fotografía en base64 de hasta el límite HTTP existente sigue funcionando: el parser de Express conserva sus límites de bytes, mientras la estructura se limita por número de elementos. Los esquemas de permisos, RLS, reclamos de roles, estados y `422 VALIDATION_ERROR` legítimos se mantienen. La protección opera en **rutas que utilicen `validate`**; no proclama cobertura de parsers externos ni analiza semántica del documento.

## Evidencia

`backend/test/validationBudget.test.js` comprueba:
- objetos y payloads offline típicos, fotografía codificada como un string, y batch de 50 operaciones admitidos al presupuesto;
- array de 4.095 valores más raíz permitido (4.096 nodos) y uno adicional rechazado;
- objetos con millares de claves, arrays grandes y anidamiento profundo rechazados sin stack overflow;
- Zod nunca se invoca ante un payload excesivo; recibe un `HttpError` de 413;
- parseo exitoso y error normal 422 sin cambios por debajo del umbral; query y parámetros también acotados.

## Límites y seguimiento obligatorio

Es una mitigación defensiva, **no** certifica el CVE como corregido ni convierte a `zod@3` en upstream patched. La base trae además un `body-parser` HIGH. Los checks `dependency-security` seguirán rojos hasta regenerar root/backend lockfiles, migrar a versión parcheada y comprobar semántica de rutas con test HTTP/PG real. No bajar la severidad ni eludir el auditor.

**Compatibilidad a verificar:** el cambio restringe estructuras JSON con más de 4.096 nodos, incluso cuando un schema anterior no fijaba límite. Verificar que ningún cliente externo legítimo requiera un metadata masivo; el piloto no documenta tal contrato. No modificar la cota global sin tests y review de seguridad.

**Rollback:** revertir este cambio y su test solo con reemplazo por un límite/validación equivalente aprobado. No desplegar por sí solo.