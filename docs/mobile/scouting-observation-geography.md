# 0S.4 — ubicación de observaciones en recorridas

La pantalla **Monitoreo → Detalle de recorrida** incorpora un explorador de GPS **sólo de lectura**. No habilita permisos nuevos: recibe únicamente `GET /scouting/runs/:id`, protegido por autenticación, empresa, módulo `scouting`, capacidad de lectura y visibilidad del responsable. Un usuario sin acceso a la recorrida no recibe la lista ni el croquis.

## Comportamiento geográfico

- Si el lote de la recorrida tiene un `Field.boundary` **GeoJSON Polygon WGS84 válido**, se muestra su perímetro real en un croquis SVG local sin mosaicos ni imágenes satelitales. Las posiciones `ScoutingObservation.point` válidas se proyectan en el mismo marco.
- Los puntos se distinguen **dentro**, **sobre el límite** y **fuera** del perímetro registrado, utilizando una regla *even-odd* que respeta huecos interiores. Fuera del perímetro no se superponen falsamente sobre el lote: figuran en la lista con coordenadas y advertencia.
- Cuando el lote **no tiene perímetro**, los puntos reales pueden representarse en un diagrama de distribución relativa sin figura de lote. Si la extensión geográfica es excesiva, cruza el antimeridiano o el límite es inválido, no se dibuja un plano engañoso.
- Las observaciones **sin GPS** o con GPS inválido se mantienen en la lista, con recuentos diferenciados; no se les atribuye posición por defecto ni centroide de establecimiento.
- El croquis representa como máximo 150 marcadores para no saturar el móvil. Si hay más, se indica la cantidad no dibujada y todas las observaciones permanecen accesibles en la lista.
- Selección en lista, filtros Todas / Con GPS / Fuera / Sin GPS, información de tipo/severidad/hora y vínculo individual a OpenStreetMap. El vínculo externaliza las coordenadas **sólo cuando se abre por acción explícita**; no hay terceros embebidos, trackers ni tiles externos.
- El GPS captura un punto aproximado del dispositivo, no una constatación catastral. Un punto clasificado fuera puede reflejar error de precisión o perímetro desactualizado; debe revisarse en terreno.
- El panel **no crea, modifica ni elimina** observaciones ni corrige GPS. Los borradores offline no se confunden con observaciones confirmadas y no aparecen hasta sincronizarse.

## Pruebas

Las pruebas puras verifican: misma proyección del perímetro, interior, borde, huecos, exterior, falta de lote, un solo GPS, extensión global/polar, URLs y límite de marcadores. Las estructurales aseguran que sólo se monta tras detalle live autorizado y que no transmite datos a OpenStreetMap de modo automático.

```bash
npm --workspace frontend run test
npm --workspace frontend run build
# El workflow postgres-isolation.yml añade PostGIS y Chromium sobre el HEAD del PR
```

**Aceptación de campo pendiente**: con permisos reales, recorrer un lote con y sin perímetro, confirmar un GPS dentro y otro fuera, con/sin conectividad; verificar ubicación tras recibir la sincronización, abrir el enlace externo intencionalmente y comprobar accesibilidad de lista/marcadores en iPhone y Android. No se modifica producción.
