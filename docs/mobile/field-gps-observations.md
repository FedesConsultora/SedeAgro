# 0S.3 — GPS opcional en observaciones de campo

El formulario de **Agregar observación** permite solicitar una posición del dispositivo únicamente cuando el operador selecciona **Usar ubicación actual**. No se utiliza `watchPosition`, no se hace tracking continuo ni se reemplaza la ubicación del lote por su centroide.

## Comportamiento

1. Abrir una recorrida autorizada y seleccionar **Agregar observación**.
2. Escribir tipo, severidad y notas. Si no se desea GPS, guardar normalmente sin seleccionar ubicación.
3. Opcionalmente, solicitar ubicación. El navegador solicita permiso si aún no fue concedido; GPS funciona solo en contextos seguros (HTTPS o localhost) y depende de la precisión del equipo, incluso sin internet.
4. Se admite solo una muestra GeoJSON `Point` WGS84 (longitud, latitud), reciente (hasta 2 minutos) y con precisión horizontal informada de máximo **150 m**. Una ubicación inexacta, antigua, denegada o ausente no se adjunta.
5. La ubicación confirmada se muestra junto a precisión aproximada. Se puede actualizar o quitar antes de guardar. El componente no persiste permiso, rastreo ni identificadores de dispositivo.
6. Al guardar, el punto optativo se valida de nuevo y se añade al **payload de observación** de la cola offline. El contenedor IndexedDB se cifra como los demás borradores con AES-256-GCM; el envío conserva sus identificadores de idempotencia. El backend `POST /sync/batches` ya acepta `point` opcional.
7. Hasta recibir la confirmación del backend, la observación sigue pendiente: la posición tampoco está confirmada en el servidor. En errores de red, el mismo payload se reintenta; nunca se genera una nueva posición automáticamente.
8. Al cerrar el formulario, cambiar de empresa/usuario o pasar a otra recorrida, se descartan del formulario la ubicación, foto y notas **no guardadas**. Borradores ya persistidos en IndexedDB no son eliminados.

La precisión indica una estimación aportada por el dispositivo, **no** exactitud catastral ni certeza de que el punto está dentro del lote. La ubicación GPS capturada intencionalmente es distinta de los metadatos EXIF de una fotografía: el sistema sigue retirando los EXIF de fotos nuevas; una posición opcional se guarda en el campo `point` separado.

## Comprobación

```bash
npm --workspace frontend run test
npm --workspace frontend run build
# Gates adicionales del workflow postgres-isolation.yml al abrir PR
```

Para probar en dispositivo real: permiso concedido, denegado, ubicación desactivada, sin señal, en exterior, cancelación antes de respuesta, cambio de usuario/recorrida, modo demo y conexión perdida/reestablecida. Comprobar que el punto no aparezca en borradores sin consentimiento, y que un punto válido quede asociado a la observación después del recibo del servidor. No representar esta función como precisión agrimensural.
