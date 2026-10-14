# 0S.7 — Capturas offline visibles en el detalle de recorrida

En **Monitoreo → Recorrida → Capturas locales de la recorrida** se muestran las observaciones almacenadas y cifradas en el navegador para la cuenta, empresa y recorrida actuales. El panel **no altera el contrato de PostgreSQL** ni modifica la cola: presenta solo un resumen sin notas, coordenadas ni archivos.

## Información que se muestra

- Conteo de **observaciones todavía sin confirmación** del servidor.
- Conteo separado de **observaciones ya confirmadas con fotografía pendiente**. Estas no se contabilizan como una nueva observación por crear, pero sí como tareas de sincronización abiertas.
- Cantidad que requiere revisión: `conflict` o `auth`, diferenciando si hay foto parcialmente sincronizada.
- Lista ordenada de capturas locales por fecha: tipo, severidad, fase, indicación booleana de GPS y foto, orientación específica. **Nunca** se muestra el texto privado de notas, nombre o bytes de foto, latitud/longitud, JWT o identificador interno en pantalla.
- Botón **Ver Sincronizaciones**, sujeto al guard de navegación de permisos que ya existe en `App.jsx`, donde se resuelven errores y fotos.
- Recarga manual y por `QUEUE_EVENT` (cambio de IndexedDB), conectividad y reactivación de la pestaña. Los registros se leen de `offlineQueue.list(session)`, no de respuesta de otra cuenta.

## Seguridad y semántica

La API `GET /scouting/runs/:id` es autoridad sobre el acceso a la recorrida: el componente solo se monta después de una respuesta **live** validada, no en demo, error ni carga. La capa local conserva el scope `tenant_id:user_id` y requiere permiso de navegación a `sync`. Un cambio de empresa/actor/rol/entitlements remonta el detalle y cambia inmediatamente la clave visual del panel; lecturas tardías se descartan. Si IndexedDB no se puede descifrar, muestra error explícito en lugar de fingir que no hay pendientes.

**No se pintan puntos GPS de un borrador en el croquis**, ni se suman como observaciones reales en la tabla, ni se genera un evento server-side. La sección sólo ofrece seguimiento de capturas locales. Los puntos GPS ya confirmados por PostgreSQL siguen visibles en la vista geográfica del Bloque 0S.4; los pendientes permanecen solo como indicadores.

La fase `photo_pending` requiere la presencia de `syncedObservationId` UUID válido con foto local. La confirmación completa de **fotografía** sigue requiriendo el recibo independiente descrito en 0S.6; el panel no deduce su éxito del recibo de observación.

## Aceptación

```bash
npm --workspace frontend run test
npm --workspace frontend run build
# GitHub Actions postgres-isolation.yml: PostGIS + controles Chromium
```

Pruebas: dos recorridas distintas del mismo operador, cambio de empresa/usuario, caída de la lectura local, 1 observación sin foto, 1 con GPS, foto confirmada parcialmente, foto en conflicto, auth 401, cierre/reapertura de pestaña y navegación protegida a Sincronizaciones.

**Antes del piloto:** verificar en iPhone/Android reales, IndexedDB bajo presión de cuota, cambio de permisos y redes inestables. Este bloque no despliega producción ni incorpora localización automática ni geoposiciones falsas.
