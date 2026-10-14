# Bloque 0Q — Datos confiables en los módulos de SedeAgro

## Objetivo

Extender el principio de TOP y del nuevo Inicio 0P al resto del producto: **una solicitud real fallida nunca se sustituye por datos inventados** y un botón que aparenta modificar información debe ejecutar una operación confirmada por el backend o no aparecer.

### Cambios por módulo

- **Establecimientos y lotes:** consulta tenant-scoped con carga, error, reintento y cero solo después de una lista `data:[]` válida. El total de lotes/hectáreas no se muestra como cero cuando la API falla. El productor/monitoreador tiene lectura y no recibe botones para crear establecimiento/lote.
- **Campañas:** mismo contrato de listas y error explícito. Solo administrador/coordinador puede crear campañas o asignar un lote. Los scouts conservan lectura según RBAC backend.
- **Reportes:** ya no introduce lotes demo ante una respuesta fallida de GIS; el catálogo para reportar es verificable.
- **Activos:** consultas independientes para maquinaria e insumos mediante `Promise.allSettled`, sin perder la fuente correcta si falla la otra. Botones de edición/archivo sin endpoint real se retiran.
- **Equipos:** separa errores de miembros y de equipos, permite reintento y evita mostrar falsos «Sin miembros» cuando falla una de las fuentes. No se puede «invitar» de verdad sin endpoint: la simulación queda exclusivamente en modo Demo.
- **Satélite:** elimina el mapa simulado y valores fijos **NDVI 0.72 / nubosidad 8%**. La pantalla lista capas registradas y expone únicamente los metadatos que realmente existen; `No informado` cuando faltan valores, sin inferir salud agronómica ni mostrar mapas inexistentes. Los botones de selección son accesibles.
- **Administración tenant:** desactiva la invitación ficticia en sesiones reales, elimina controles de edición de miembros que no tenían handlers, muestra módulos de la sesión solo en lectura y no presenta un historial de auditoría predefinido como real. El modo Demo conserva ejemplos claramente identificados.

### Contrato y verificación

`useTenantCollection` particiona resultados por modo y `tenantId`, descarta respuestas obsoletas tras cambio de cuenta, valida que `response.data` sea una lista y deja `status:error` si la API falla. Los datos mock solo se leen al seleccionar expresamente modo Demo. `ResourceLoadNotice` provee una advertencia unificada, accesible y con reintento.

La suite `resourceTruth.test.js` cubre carga de listas inválidas y límites numéricos de NDVI/nubosidad. La aceptación real de Chromium/PostgreSQL registra una cuenta y fuerza respuestas 503 en Establecimientos y Campañas; verifica que no aparezcan ni la finca ni la campaña de demostración. Se conservan los gates previos de usuarios/roles, JWT HttpOnly, RLS, offline cifrado, evidencia y Nginx.

### Limitaciones y próximos bloques

Este PR no incorpora un proveedor satelital ni visualizador de raster/tiles, no implementa invitaciones/edición de miembros, ni almacena eventos de auditoría general nuevos. Los tabs y submódulos sin backend deben pasar por un nuevo inventario de acciones, no simular éxito.

**0R:** detalle compacto de órdenes/recorridas, historial real, operaciones de miembros y jerarquía de lotes/campañas; endpoints y autorizaciones verificables. **0S:** notificaciones reales, navegación y señal de conectividad/cola en móvil. **0T:** sistema visual consolidado y pruebas físicas de aceptación.

No se realizaron cambios de esquema, despliegue VPS ni cambios en las políticas RLS. Las pruebas automáticas Chromium no certifican Android/iOS físicos ni staging.
