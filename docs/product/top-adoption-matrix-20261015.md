# SedeAgro — Matriz de adopción TOP y preparación de piloto (15/10/2026)

Este registro complementa `docs/product/top-inspired-operational-roadmap.md`.
No significa clonar TOP ni que exista equivalencia de producto: trasladamos
contratos de UX, seguridad, navegación, consistencia y pruebas que sirven
al flujo agro `lote → recorrida/evidencia → orden → seguimiento`.

## Evidencia de adopción en main al iniciar 0S.18

| Contrato trasladable de TOP | SedeAgro: evidencia en GitHub | Estado de código / límite |
| --- | --- | --- |
| Inicio accionable, métricas verdaderas, estados parciales | PR #16, `operationsHome.js`, `Dashboard.jsx` | Integrado; no inferir salud agronómica sin observaciones |
| No presentar mocks como datos live | PR #17; `truthful-resources-0q.md` | Integrado; probar regresiones por módulo |
| Acceso por tenant, capacidad y rol | PR #5, #14, #16; `navigationAccess.js`, RLS | Integrado; frontend no sustituye autorización servidor |
| Detalles compactos con contexto real | PR #20, #22, #23 | Integrado para órdenes, recorridas y GIS contextual |
| Notificaciones y señales offline operativas | PR #25, #27; `NotificationCenter.jsx`, `FieldSyncStatus.jsx` | Integrado; no sustituir error real por éxito aparente |
| Cola local cifrada, recuperación e idempotencia | PR #8–#13, #33–#45 | Integrado en Web; no equivale a pruebas físicas en móviles |
| Evidencia verificable, historial eficiente y revocación | PR #47–#57 | Integrado, CI previo verde; sin despliegue |
| Privacy fanout y foreground revalidation | **0S.18, issue #58**; `SessionContext.jsx` y `sessionTabSync.js` | En implementación/validación mediante PR; no afirmar completo antes del gate |
| Coherencia visual, estados de UI, teclado y responsive | `frontend/src/styles/main.scss`, componentes por módulo | **Pendiente 0T:** auditoría transversal y revisión visual real |
| Cierre de versión con gates verificables | `docs/pilot-staging-readiness-0m.md`, `docs/pilot-field-acceptance-0l.md` | **Pendiente:** staging real, Android/iPhone físicos y cobertura rural |

## Siguiente secuencia: bloques concretos sin pisar ramas

### 0T.1 — Contrato visual/accesible por recurso

- Inventariar patrones de TOP `PageHeader`, `EmptyState`, focus,
  teclado y errores, sin importar componentes ajenos al dominio agro.
- Unificar encabezados y estados `loading / empty / error / forbidden` en
  establecimientos, campañas, monitoreo, órdenes y reportes.
- Mantener datos live y permisos sin reemplazar errores por mocks; probar
  teclado, Escape, foco restaurado, zoom 200 %, responsive 320–768 px.
- Gate: pruebas focalizadas, build, Chromium real y regresión RBAC.

### 0T.2 — Piloto móvil verificable

- Matriz por iPhone Safari y Android Chrome: cámara, GPS voluntario,
  desconexión/reconexión real, IndexedDB cifrada, cuota, refresco y multi-tab.
- GPS/EXIF debe respetar consentimiento; evidencia no se borra silenciosamente.
- Verificación de sesiones y permisos cuando dispositivo se reanuda.
- Gate: registro de dispositivo, versiones, escenario, resultado y evidencia.
  Simulaciones de Chromium **no** habilitan un check de aceptación física.

### 0T.3 — Release candidata sin afirmaciones falsas

- Aplicar migraciones pendientes solo en staging aislado, verificar
  PostgreSQL/PostGIS/RLS con la misma versión exacta del commit candidato.
- Seguridad (cookies, CSRF, CSP), backups/restauración, workers, tiempos de
  carga, logs y rollback documentado, sin filtrar secretos.
- Cerrar fallos bloqueantes y probar el recorrido lote→recorrida→evidencia→OT
  por perfiles (admin, coordinador, scout, contratista, productor).
- Publicación productiva **solo** cuando gates de staging y aceptación
  física estén verificados; no inferirla de CI exitoso.

## Alcance funcional: no confundir madurez de plataforma con paridad de TOP

El blueprint de SedeAgro exige GIS, campañas, monitoreo offline,
órdenes, reportes, imágenes satelitales e integraciones progresivas. TOP
aporta patrones de software confiable, no reglas de agronomía ni módulos de
calendario/chat/gimnasio a copiar. Una nueva capacidad requiere valor
agronómico explícito, control de tenant y aceptación por actor.

## Política de cierre

Cada bloque compara HEAD remoto de `main`, PRs abiertos e issue #18; reserva
paths antes de editar. Commits atómicos y PR enfocados; ejecutar los gates
disponibles sobre SHA exacto. No eliminar borradores para resolver errores,
no ignorar fallos de RLS y no declarar release por falta de pruebas.
