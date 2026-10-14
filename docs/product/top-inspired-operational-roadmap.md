# SedeAgro — Revisión de producto comparada con TOP (Bloque 0P)

## Referencias concretas

Se revisaron archivos de `Enzopinotti/TOP` en su main `c9dffb340ef8f9487f4da0f803adf5b5e58ae437`: `apps/web/src/features/home/OrganizationHomeWorkspace.tsx`, `apps/web/src/features/tasks/TaskWorkViews.tsx`, `apps/web/src/components/ui/PageHeader.tsx` y `EmptyState.tsx`. El aprendizaje trasladable es **trabajo real y visible, estados de carga/error separados, priorización objetiva, acciones próximas a cada registro, navegación por permisos y densidad adaptable**; no copiar componentes enteros ni introducir funcionalidades de TOP ajenas al campo.

Se revisó SedeAgro sobre main `9df4570cd7455743c9767501b57ece8056538272`. El resultado siguiente describe **hallazgos de código**, no validación de todos los flujos en dispositivos físicos.

## Hallazgos y decisiones

| Área | Estado encontrado | Prioridad | Resolución |
| --- | --- | --- | --- |
| Inicio (`Dashboard.jsx`) | Mapa SVG decorativo descrito como semáforo en tiempo real; `Sin alertas` inferido restando órdenes urgentes a lotes; `catch` sustituía API fallida por mock | Crítica | **0P:** eliminado mapa y falsa salud; métricas de recursos efectivamente consultados, estados parciales y acciones reales |
| Órdenes (`WorkOrdersPage.jsx`) | Lista no navegable por teclado, error de backend reemplazado por mock, alta visible para todos los roles | Crítica | **0P:** fila botón, búsqueda y filtros reales, carga/error/reintento, apertura de orden elegida y alta solo para admin/coordinador |
| Navegación (`App.jsx`) | Mostrar un módulo pagado podía presentarlo a un rol sin la capacidad correspondiente | Alta | **0P:** filtro por rol+entitlement, protecciones de pantalla admin y priorización del inicio incluso para contratista y productor |
| Monitoreo (`ScoutingPage.jsx`) | Las recorridas se muestran con errores honestos, pero no permitían navegación directa desde el inicio | Alta | **0P:** la prioridad abre y expande su recorrida por ID |
| Establecimientos (`FarmsPage.jsx`) | `catch` sustituye datos reales por mock | Alta | **0Q:** estados explícitos y permisos de alta/edición según RBAC |
| Campañas (`CampaignsPage.jsx`) | `catch` sustituye datos reales por mock | Alta | **0Q:** error parcial/reintento y filtros de trabajo verificables |
| Activos (`AssetsPage.jsx`) | `catch` establece maquinaria/insumos mock después de error real | Alta | **0Q:** carga diferenciada por recursos, permisos y acciones |
| Reportes (`ReportsPage.jsx`) | `catch` carga lotes mock ante error de API | Alta | **0Q:** mantener fallo visible y auditar estados `queued/failed/ready` |
| Satélite (`SatellitePage.jsx`) | `catch` carga capas mock ante error real; se debe distinguir capa disponible de procesamiento pendiente | Alta | **0R:** eliminar fallback, contratos de ingestión y mapa con geometría real |
| Equipos (`TeamPage.jsx`) | Contiene fallback mock en excepción de API | Alta | **0Q:** reemplazar por error/reintento y corregir acciones por rol |
| Shell / Topbar (`Topbar.jsx`) | Control de notificaciones presente; verificar si conduce a un recurso real antes de etiquetarlo como funcional | Media | **0S:** notificaciones, navegación contextual y accesibilidad del menú |
| Detalle de órdenes (`WorkOrderDetailDrawer.jsx`) | Presenta múltiples secciones y transiciones, pero la autorización visual depende más del contexto que del permiso concreto | Alta | **0R:** detalle compacto, evidencia e historial, transición por rol validada desde backend |
| Conectividad offline (`SyncPage.jsx`) | Cifrado, idempotencia, conflictos, capacidades y reintentos ya cubiertos con pruebas Chromium en bloques anteriores | Media | **0S:** integrar indicador compacto de pendientes en navegación sin exponer datos de otro tenant |
| Estilos (`main.scss`) | CSS extenso de legado y vistas muy distintas; responsive parcial | Media | **0T:** tokens, superficie de diseño unificada, estados compartidos y captura móvil |

## Bloque 0P — Contrato verificable

1. **Nunca** mostrar datos mock en modo autenticado si una API devuelve 4xx/5xx, una estructura inválida o un fallo de red.
2. Una métrica aparece en blanco/guion si su fuente no pudo consultarse. Un cero solo representa una colección obtenida correctamente y vacía.
3. La lista de prioridades solo incluye órdenes reales abiertas vencidas, urgentes/altas o pendientes de aprobación, y recorridas planificadas atrasadas/en curso; no se infiere salud del cultivo sin datos observados.
4. El acceso se filtra por entitlement **y rol**, sin sustituir la autoridad del backend. La vista del contratista ofrece órdenes asignadas; la del productor usa únicamente GIS con sus `producer_access_grants` vigentes.
5. Cada tarjeta tiene un destino real. Las alertas abren la orden o recorrida exacta. Si el usuario pierde acceso, el destino falla de manera explícita.
6. La demostración es **explícita**, etiquetada y no mezcla registros de ejemplo con el backend.
7. La UI se prueba mediante funciones puras (roles, métricas, orden y búsqueda) y mediante Chromium autenticado: fallo parcial de órdenes **no** reintroduce ejemplo demo.

## Siguientes bloques propuestos

**0Q — Operación confiable por módulos:** cerrar todos los fallbacks mock de Establecimientos, Campañas, Equipos, Activos y Reportes, con errores explícitos, formularios por rol, navegación teclado y pruebas de fallo parcial.

**0R — Detalle y GIS útil:** hacer compactos los detalles de órdenes/recorridas, vinculando evidencia, asignaciones, cambios y lotes con geometría real. Una pantalla no debe declarar riesgo satelital si no existe observación o procesamiento verificable.

**0S — Experiencia móvil de campo:** navegación móvil y conectividad unificadas, centro de notificaciones respaldado por la API, entrada rápida a tarea asignada y pendientes cifrados sin exponer contenido de otro usuario/tenant.

**0T — Diseño coherente y piloto:** unificar estados vacíos, skeletons, búsqueda, densidad, encabezados y formularios entre módulos; completar validaciones Android/iOS físicos y staging. No declarar producción lista por CI verde.

No se realizan cambios de esquema, alteraciones de roles backend ni despliegue en VPS en el Bloque 0P.
