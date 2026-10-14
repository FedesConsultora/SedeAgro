# SedeAgro — reglas para agentes de desarrollo

Estas instrucciones aplican a humanos, Codex y otros agentes. **GitHub remoto y el código del `main` exacto** son la autoridad; prompts, planes y SHAs antiguos son contexto, no evidencia de implementación.

## Antes de tocar código
1. Leer `README.md`, la documentación del módulo y el contrato de permisos en `docs/security/authorization-matrix.md`.
2. Consultar SHA actual de `main`, últimos merges, PRs abiertos, issues y ramas activas. Nunca asumir que un bloque sigue pendiente.
3. Reservar el carril y los paths en [issue 0R](https://github.com/FedesConsultora/SedeAgro/issues/18) o el issue propio: `CLAIM: carril, rutas, base SHA, rama, dependencias`. Si hay una reserva solapada, no editar esos paths.
4. Delimitar un cambio funcional con aceptación verificable; branch exclusiva desde el `main` actual. Informar paths que **no** se van a modificar.

## Entrega
- Una unidad lógica por commit; nunca commits vacíos ni cambios de relleno. Usar `feat/fix/test/docs/chore(scope): resultado`.
- Nunca push directo ni forzado a `main`. No reescribir ramas de otros agentes. Revisar diff por path, no incluir secrets ni output generado.
- PR hacia `main` con base/HEAD, paths, contratos, permisos, migraciones, evidencia real, riesgos, rollback y pendientes. Usar `.github/PULL_REQUEST_TEMPLATE.md`.
- Reconsultar `main` y PRs antes de merge; si avanzó, reconciliar el delta. Integrar con **merge commit** para conservar commits atómicos (sin squash).
- Registrar `HANDOFF: PR, HEAD, pruebas, pendientes y próxima dependencia` en el issue de coordinación. Un agente no declara aprobado su propio trabajo sin evidencia.

## Política temporal de CI
Se priorizan PRs chicos y se permite **no esperar GitHub Actions**, por decisión del responsable del proyecto. Esto no significa `CI PASS` ni piloto validado. Ejecutar las verificaciones locales pertinentes **cuando estén disponibles** y registrar los gates no ejecutados. Si no puede verificarse un cambio crítico de autorización, RLS, datos, migraciones, privacidad u offline, dejarlo abierto o bloqueado y no fusionarlo a ciegas. Release/staging requieren aceptación separada.

## Fronteras de seguridad y producto
- SaaS multiempresa: `tenant_id`, FORCE RLS, permisos backend, recursos asociados y revocaciones vigentes.
- No inventar lecturas de API, NDVI, mapas, alertas, auditorías, reportes ni estados de éxito.
- Offline: no perder borradores, no duplicar observaciones/evidencias, no mezclar usuarios/tenants; conservar cifrado e idempotencia.
- El backend es autoridad sobre transiciones y acceso por rol. Una UI oculta no reemplaza el `403/404` del servidor.
- No desplegar ni modificar production, secretos, DNS ni TOP sin autorización separada.

## Propiedad inicial de módulos
- **Carril A órdenes:** `frontend/src/components/WorkOrderDetailDrawer.jsx`, tests/helpers de órdenes; backend `workOrders` sólo con coordinación.
- **Carril B recorridas:** `frontend/src/pages/ScoutingPage.jsx` y componentes de recorridas/evidencias; backend `scouting` según claim.
- **Carril C GIS:** establecimientos, lotes, geometrías PostGIS y GIS contextual.
- **Integrador:** `README.md`, `AGENTS.md`, `.github/`, migraciones, capa de sesión, permisos y código transversal: una sola persona/agente a la vez.

La reserva es **temporal y por PR**, no propiedad permanente. Detalles, plantilla y handoff: [protocolo paralelo](docs/engineering/parallel-delivery.md).
