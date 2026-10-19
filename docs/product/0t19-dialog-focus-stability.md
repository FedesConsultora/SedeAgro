# 0T.19 — Estabilidad de foco Chromium en modales de coordinación

## Evidencia y alcance
En el `main` exacto `4334efcbea96fd4500482e8a9cd507e2438b2a2d` el [issue #86](https://github.com/FedesConsultora/SedeAgro/issues/86) documenta una **intermitencia reproducida una vez** en el gate de Chromium: el primer intento del CI posmerge de 0T.13 no encontró foco en el botón Crear después de `Shift+Tab`; el mismo SHA pasó al reejecutar el job. El ajuste 0T.14 ya esperó que la consulta de productores terminara antes de exigir el foco. El componente compartido `Modal.jsx` conserva el trap real para Tab/Shift+Tab, Escape y restauración del invocador. Ningún log demuestra todavía un defecto sistemático en el trap del producto.

## Lo que añade este bloque
- Nuevo helper `scripts/support/assert-dialog-focus.mjs`: espera **como máximo 750 ms** (render de Chromium con sondeo por frame), pero no reintenta la interacción, no hace `focus()` y no convierte fallos en PASS. Si falta el foco correcto arroja error contextual de aserción.
- Diagnóstico ante fallo estrictamente **sin datos de formularios**: solo indica si el diálogo existe, si el foco está dentro/en el nodo raíz, etiqueta/role del nodo activo, estado `disabled`, número de elementos enfocables visibles y etiquetas de primero/último. **No** vuelca innerHTML, texto, IDs, valores de inputs, notas, JWT, rutas privadas o nombres de personas.
- `scripts/acceptance-browser-cookie.mjs` abre y cierra **cuatro veces seguidas** el modal Nuevo establecimiento con API real de productores. Cada ciclo exige un botón `Crear` habilitado tras el lookup, foco inicial en raíz, `Shift+Tab` en Crear, `Tab` en cerrar, Escape y regreso al disparador. Los cuatro ciclos se ejecutan en una misma sesión real/cookie con Express/PostgreSQL.
- Se comprueba el comportamiento con error HTTP `503` de consulta de productores: Crear permanece deshabilitado, `Shift+Tab` desde la raíz va a **Cancelar**, `Tab` vuelve al primer botón habilitado (Cerrar) y el formulario sigue sin inventar productores.
- Se repite el contrato en el formulario Nueva orden bajo fallo de consulta de lotes: botón Crear orden deshabilitado, focus trap desde raíz va a Cancelar, Tab a Cerrar, Escape cierra y devuelve el foco a Nueva orden. No se crea una orden al fallar la dependencia.
- El script sigue verificando cookie HttpOnly, revocación real, logout y ausencia de mock fallback. El workflow de PostgreSQL ya lo ejecuta sobre **cada PR y push en main** y no se modifica para conservar su línea de autoridad.

## Validación exigida
1. CI del PR, **HEAD exacto**: dos jobs verdes, ejecución del Chromium repetido, tests de backend/frontend y PostgreSQL/PostGIS antes y después de restaurar, backup/restore y FORCE RLS.
2. Confirmar `main` y ausencia de PR/CLAIM solapado, merge **normal** preservando commits, CI independiente del SHA del merge.
3. Si alguno de los ciclos falla, documentar el punto preciso y el diagnóstico sanitizado, no reintentar a ciegas ni marcar verde con un SHA anterior.

## Límites de aceptación
El paso del gate en un PR y luego del posmerge muestra evidencia adicional frente a una intermitencia **pero no prueba ausencia estadística de flakes**. El issue #86 permanece abierto hasta contar con repetición suficiente o un defecto identificado y corregido. Chromium automatizado no reemplaza lectura manual con VoiceOver/TalkBack, dispositivos rurales ni auditoría completa WCAG. No se cambiaron lógica de producto, modal/portal compartido, autorización, backend, RLS, migraciones, inventario, API, offline, GIS, scouting, CI ni despliegue. Rollback aislado: revertir los cambios de script y el helper de QA.

## Investigación en el PR #98 (evidencia nueva)

- La primera corrida sobre `2af113856898cfe4abd1eb02d80ff197b708bae9` fue detenida por dos tests unitarios **estáticos** que seguían buscando el antiguo `console.log` y `document.activeElement` inline. Se actualizaron en commits propios para exigir las nuevas comprobaciones reales, sin reproducir frases antiguas como bypass.
- La siguiente ejecución Chromium con cuatro ciclos **reprodujo una divergencia en el ciclo 3**: el foco siguió dentro del diálogo, pero quedó en un botón distinto de «Crear». El diagnóstico inicial confirmó que `activeTag=button`, `activeInsideDialog=true` y 7 controles enfocables visibles; no confirmó si el botón Crear estaba deshabilitado exactamente cuando se disparó Shift+Tab. Eso **no autoriza atribuir la causa al trap** ni declarar la prueba superada.
- Se fortaleció la prueba: un oyente de teclado de **fase de captura** observa qué elementos estaban realmente habilitados al momento del `keydown`, antes de que el trap procese la tecla en fase de burbujeo. Exige que el foco final coincida con el **último control habilitado de ese instante**. Un check anterior de `Crear` habilitado sigue verificando el lookup, pero no se presume que su estado sea inmutable durante la transición asíncrona. La captura no manipula el foco y falla si el trap elige otro control.
- En los casos negativos con error 503, el control Crear queda deshabilitado y se conserva la expectativa estricta de que **Cancelar** sea el último tabulable y **Cerrar** el primero.
- La comparación con el estado de elementos en el instante del evento distingue mejor una transición de habilitación de un error en el trap. El issue #86 **continúa abierto** y requiere seguimiento longitudinal en runs independientes. La validación exact-HEAD y posmerge se registran sin borrar los intentos fallidos.
