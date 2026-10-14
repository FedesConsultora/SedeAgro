# SedeAgro — Bloque 0L: captura de campo y criterios del piloto

## Implementación verificable

En el formulario **Agregar observación** de una recorrida asignada, el monitoreador puede seleccionar la cámara trasera (si el navegador ofrece `capture=environment`) o un archivo existente, ver una previsualización local y retirar la foto. La captura sigue siendo opcional: observaciones de texto funcionan sin permiso de cámara.

`frontend/src/services/offlinePhoto.js` distingue:
- **Origen de cámara:** JPEG/PNG/WebP, hasta **12 MiB** y máximo **40 millones de píxeles** decodificados para evitar consumos excesivos en teléfonos modestos.
- **Guardado offline:** máximo **512 KiB**, compatibilidad con la API de evidencias del backend y firma inicial del formato.
- **Compresión:** si el origen supera 512 KiB, se decodifica en el navegador, se escala preservando proporción y orientación informada por `createImageBitmap`, y se intenta JPEG desde 2048 hasta 640 píxeles de lado mayor con calidades decrecientes. El primer resultado que cumpla el límite se usa; si no existe, la aplicación muestra un error **sin afirmar que lo guardó**. El lienzo coloca fondo blanco en las zonas transparentes.
- **Archivo pequeño:** se conserva sin reprocesarlo; un JPEG pequeño puede mantener metadatos EXIF, incluida información de ubicación. No se promete limpieza universal de metadatos. Los archivos recomprimidos se re-codifican y no reutilizan bytes EXIF originales.

La imagen y las notas se guardan **en la misma entrada cifrada AES-GCM** de IndexedDB. Se sigue enviando primero la observación y después el adjunto, con UUID de idempotencia independientes y ACK del servidor antes de eliminar la cola.

Se añadió `offlineConflictGuidance.js`: nunca infiere confirmación a partir de un error HTTP. **Únicamente** `syncedObservationId` o un recibo válido permiten declarar que la observación se aplicó. La pantalla diferencia `Observación pendiente` de `Observación confirmada · fotografía pendiente`, informa si faltan permisos o la recorrida cerró, y avisa que borrar localmente no revierte los registros ya confirmados. El reintento manual evita iniciar un segundo envío desde el evento de cambio de cola de la misma pestaña.

## Condiciones del piloto

Estas son **condiciones de aceptación por ejecutar**, no una certificación ya completada. Cada combinación de dispositivo/navegador debe mostrar evidencia y resultado: `PASS`, `FAIL`, `BLOCKED` o `NOT_RUN`.

| ID | Plataforma | Comprobación | Criterio |
| --- | --- | --- | --- |
| MOB-01 | Chrome Android 12+ | Cámara trasera y galería | Los dos controles aparecen y producen JPEG/PNG/WebP compatible |
| MOB-02 | Safari iOS 17+ | Cámara, galería, orientación | Orientación correcta, foto visible y sin cierre inesperado |
| MOB-03 | Android e iOS | Imagen grande de entre 1 y 12 MiB | Resultado válido de hasta 512 KiB o error explícito, sin duplicar |
| MOB-04 | Android e iOS | Modo avión tras capturar | Borrador cifrado persiste, no se anuncia alta en backend |
| MOB-05 | Android e iOS | Cerrar por completo y abrir offline | Interfaz y borradores disponibles; sin API ni fuentes remotas necesarias para datos |
| MOB-06 | Android e iOS | Reconexión y pérdida de confirmación | Una observación, una foto, recibo idempotente; sin duplicados |
| MOB-07 | Android e iOS | Recorrida cerrada tras sincronizar observación | Conflicto de foto visible, texto ya confirmado intacto |
| MOB-08 | Android e iOS | Cambio de tenant/cuenta | No se muestran ni transmiten borradores de otra cuenta |
| MOB-09 | Android e iOS | Poco espacio y limpiar datos del navegador | Falla de manera explícita, sin confirmar una escritura que no persistió |
| MOB-10 | Android e iOS | Permiso de cámara denegado | Se conserva entrada por galería y observación de texto |
| MOB-11 | Android e iOS | Foto HEIC/HEIF y >40 MP | Se informa incompatibilidad/límite, sin prometer subida |
| MOB-12 | Android e iOS | Datos sensibles EXIF | Se valida política de privacidad, aviso y ausencia de extracción automática de ubicación |
| SEC-01 | Backend PostGIS | Revocación de asignación | 404/403 y sin leaks cross-tenant; los retries no reviven permisos |
| SEC-02 | Navegador | XSS y CSP | Revisión de scripts del mismo origen; **AES local no protege frente a XSS** |
| OPS-01 | VPS staging | Migraciones, rollback y restauración | Backup verificado, pruebas SQL/RLS, healthcheck y rollback probado |
| OPS-02 | VPS staging | HTTPS, headers, Sentry/logs y cuotas | Revisar protección de red/errores y retención; sin datos privados en logs |

## QA automatizado incorporado al PR

- **Node frontend:** plan de fotos (12 MiB, 512 KiB), límites de píxeles, nombres seguros, estados parciales/errores y contador de cola.
- **Chromium Playwright:** generación de JPEG ruidoso de cámara, reducción en canvas a JPEG de <=512 KiB, validación de nombre/tipo, entrada AES-GCM, recarga y recuperación sin cambiar `client_upload_id`; persisten los gates previos de IndexedDB v1→v2 y apertura sin conexión.
- **PostgreSQL/PostGIS:** se vuelven a ejecutar las pruebas de RLS, permisos de recorridas, sincronización y evidencias idempotentes.
- **CI:** no se consideran aprobados Android/iOS ni WebKit físicos por pasar Chromium Linux.

## Límite y despliegue

El frontend no realiza sincronización con la pestaña cerrada ni hace uploads de video/PDF offline. Un dispositivo sin soporte de decodificación JPEG o Canvas puede no reducir fotos grandes; ofrecer un archivo menor es el fallback. La cola no modifica la observación confirmada ni permite editar silenciosamente una foto conflictiva. Continúan pendientes compresión en worker, minimización de EXIF para archivos pequeños, test WebKit, endurecimiento CSP que respete estilos actuales y pruebas de carga de almacenamiento.

**No desplegar al VPS de producción** durante este bloque. Primero staging con backup de PostgreSQL, aplicar migraciones existentes, controlar roles RLS y verificar MOB/SEC/OPS con evidencia.
