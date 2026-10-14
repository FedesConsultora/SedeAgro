# Entrega paralela — SedeAgro

**Estado:** protocolo vigente; no certifica ningún módulo. Adaptación del control de propiedad, handoff y commits atómicos de los repositorios Podómetro y LosApuntes. La fuente de verdad del trabajo activo son los PRs y comentarios de issues de GitHub, no esta página.

## Inicio de bloque (cada agente)
1. Leer `AGENTS.md`, luego GitHub `main` remoto, commits y PRs/branches activos.
2. Confirmar si el objetivo aún falta en código. No ejecutar un ticket histórico sin inspección.
3. En [coordinación 0R](https://github.com/FedesConsultora/SedeAgro/issues/18) o el issue del bloque, dejar `CLAIM: A/B/C | paths | main@SHA | branch | dependencias`. La reserva dura hasta el PR/merge/handoff; liberar si se abandona.
4. Una rama independiente por bloque; **no compartir worktrees ni stages**. Prevenir solapamientos con paths, no sólo con nombres de feature.
5. Si otro agente reclama la misma ruta, acordar dueño y dividir el trabajo; el segundo agente puede continuar en otra ruta, sin sobrescribir cambios.

## Carriles inicialmente independientes
| Carril | Entrega | Rutas de alto riesgo de colisión |
| --- | --- | --- |
| A | Órdenes de trabajo: detalle, transiciones UX, pruebas | `WorkOrderDetailDrawer.jsx`, `workOrders/router.js`, helpers de órdenes |
| B | Recorridas: detalle, observaciones, evidencias y QA | `ScoutingPage.jsx`, `Scouting*.*`, `scouting/router.js` |
| C | GIS: campos/lotes y geometrías reales | `FarmsPage.jsx`, `fields/router.js`, `farms/router.js` |
| Integración | Config, auth, RLS, migraciones, shell, documentación transversal | `AGENTS.md`, `README.md`, `SessionContext.jsx`, `backend/db/migrations/` |

Si una entrega necesita rutas de otra columna, pasar el contrato al issue y acordar un PR dependiente. **No crear tres implementaciones de la misma API.**

## Handoff reproducible
Comentar antes de solicitar integración:

```text
HANDOFF: <PR> / <carril>
BASE: main@<SHA> ; HEAD: <SHA>
CAMBIOS: <paths y resultado>
CHECKS: <comandos ejecutados/resultados; NO EJECUTADO cuando aplique>
CRÍTICOS: <RLS/auth/migración/offline: verificación o bloqueo>
RIESGOS: <P0/P1/P2> ; DEPENDENCIAS: <PRs>
SIGUIENTE: <dueño + alcance>
```

## Integración
- Confirmar que no haya reservas o PRs en conflicto y que el HEAD no cambió.
- Reconciliar `main` por fast-forward/merge ordinario; nunca hacer push forzado.
- Revisar diffs y commits de propósito único; ejecutar tests pertinentes locales si hay entorno.
- De forma **temporal**, se permite integrar sin esperar Actions; marcar `CI NO EJECUTADO / PENDIENTE`. No saltar gates críticos. Si hay fallo conocido, corregirlo antes de merge.
- Fusionar con merge commit (no squash), verificar el nuevo `main@SHA` y registrar resultado en issue.
- Continuar con el siguiente bloque pendiente del producto, no sólo con otro documento o check.

## Invariantes
Aislamiento tenant y RLS; permisos de backend; autenticación/sesiones revocables; evidencias privadas; colas offline cifradas e idempotentes; los errores de API no se convierten en arrays vacíos ni demostraciones ficticias. La aceptación de piloto exige staging, permisos negativos, PostGIS real y dispositivos físicos: **merge no equivale a release**.
