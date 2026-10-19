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
