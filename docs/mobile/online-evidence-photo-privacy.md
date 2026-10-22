# Piloto 0.1 — privacidad de fotografías cargadas online

## Defecto real observado en main 2752a121 (21/10/2026)
El flujo de observación offline ya convertía todas las fotografías a JPEG por Canvas antes de cifrar los borradores, evitando copiar los bytes EXIF/GPS/IPTC originales. En cambio, `EvidenceUploadModal` (adjuntar evidencia a una observación existente) y `WorkOrderExecutionEvidence` (respaldo de un parte presentado) utilizaban `FileReader.readAsDataURL(file)` directamente para **todas** las clases de archivo. Esto podía guardar y redistribuir metadatos GPS originales sin una decisión explícita del usuario.

## Corrección en interfaz web real
- La carga de fotografías JPEG/PNG/WebP de ambas interfaces ahora usa el pipeline existente `readOfflinePhoto` de `offlinePhoto.js`: decodificación, Canvas y un **JPEG nuevo máximo 512 KiB** que no copia los metadatos del archivo fuente.
- **MOB-03 online**: se acepta fotografía fuente JPEG/PNG/WebP de **1 byte hasta 12 MiB** en ambas pantallas, el mismo límite del flujo offline. La foto se decodifica, limita a **40 megapíxeles** y se transforma en un JPEG **<=512 KiB** antes del POST. El frontend nunca envía los bytes originales. Un origen superior a 12 MiB se rechaza antes de abrir el decodificador. Los PDF **siguen limitados a 2 MiB** y conservan todos sus bytes y metadatos originales, lo cual advierten los formularios. No se procesa PDF como imagen ni se envía a terceros.
- Si el navegador no puede decodificar/recodificar la foto, la carga falla explícitamente. **Nunca** se vuelve a subir el JPEG/PNG/WebP original como alternativa.
- La carga online de observaciones agrega un `client_upload_id` nuevo por archivo y reutiliza el mismo Base64 convertido al reintentar. Antes lo omitía y podía duplicar el adjunto tras perder un ACK.
- La carga del parte mantiene el mismo `client_upload_id` al reintentar una respuesta HTTP ambigua y conserva **exactamente el mismo Base64 convertido**, no vuelve a ejecutar Canvas con ese UUID; otra selección genera un UUID y payload nuevos.
- Un cambio de cuenta/tenant/recurso o cierre de formulario durante conversión invalida un ticket local e impide iniciar la subida desde el callback anterior. Los metadatos de un usuario no se heredan por compartir tenant.


## MOB-11 — fotos nativas HEIC/HEIF en iPhone (admisión condicionada al navegador)
- El selector de recorrida (cámara/galería) y ambos adjuntos online ofrecen `image/heic` y `image/heif`, además de JPEG/PNG/WebP. Una imagen fuente sigue limitada a **12 MiB** y **40 MP**. El PDF continúa limitado a **2 MiB** sin transformación.
- HEIC y HEIF son **solo MIME de origen** (`CAMERA_SOURCE_MIME_TYPES`), nunca un tipo aceptado en `validateOfflinePhoto` ni un `mime_type` de subida. La única ruta válida es decodificar mediante `createImageBitmap` o `HTMLImageElement`, dibujar píxeles en un Canvas, exportar JPEG <=512 KiB y validar firma/tamaño antes de cifrar/POST.
- La compatibilidad depende del navegador, versión, dispositivo y codec; Safari iOS moderno puede decodificar fotos HEIC nativas, pero Chromium/Firefox y otros entornos pueden rechazarlas. Ante ausencia de decodificador o JPEG inválido: error visible, **sin borrador de foto y sin enviar bytes HEIC/HEIF originales**. El usuario puede elegir una versión JPEG; no se descargan librerías externas ni se sube a conversores remotos.
- Esto no es certificación de iPhone: Safari/iOS físico y Android permanecen **NOT_RUN**. La foto puede ser aceptada como fuente pero no prometer vista previa ni orientación sin pruebas en dispositivo. Los históricos no se alteran y la API REST externa no sanea universalmente EXIF.

### Casos de aceptación física pendientes (staging autorizado)
1. iPhone con captura Alta eficiencia, Safari compatible: imagen HEIC real de galería y cámara en recorrida, observación online y orden; verificar carga/cola privada únicamente JPEG <=512 KiB, orientación y hash, ausencia de EXIF GPS de origen.
2. Repetir con HEIF del sistema, dispositivo con JPEG automático y permisos de Fotos limitados; no asumir que `accept` obliga a Safari a conservar el tipo HEIC original.
3. Navegador sin decodificador HEIC: selector puede devolver imagen HEIC, pero debe mostrar error recuperable sin almacenar ni transferir original; elegir JPEG después debe funcionar.
4. Exceder 12 MiB, 40 MP, archivo corrupto y cambio de tenant durante conversión; verificar rechazo, limpieza de URL y ausencia de envíos tardíos. Repetir sin red y después de reconexión.

## Qué demuestra y qué no
- Tests unitarios: fuente 2 MiB+1 y exactamente 12 MiB admitidos como foto, fuente 12 MiB+1/imagen vacía/nombre inseguro rechazados antes de Canvas, PDF 2 MiB+1 rechazado, MIME no admitido, rechazo de foto no convertida, no degradación a bytes originales, PDF intacto, caché de reintentos e integración estática en ambos formularios.
- CI browser/Chromium existente: ya ejercita `readOfflinePhoto` con JPEG EXIF sintético, Canvas y persistencia cifrada; no sustituye QA física de Safari iOS o Android.
- **NO** hay saneamiento impuesto en la API: un cliente REST externo todavía puede enviar imágenes con metadatos; el backend valida MIME/firma/bytes y RLS, no la eliminación de EXIF. El flujo privado web queda mitigado, pero una política uniforme de ingestión backend sigue pendiente de evaluación por seguridad.
- Las fotografías previamente guardadas no se modifican; podrían contener EXIF privado. Requieren revisión de acceso, política de retención y tratamiento de históricos.
- Tampoco se garantiza la orientación/calidad visual en Safari físico, ni se anonimiza el contenido visible (por ejemplo, matrículas, caras o coordenadas escritas).

## Aceptación externa requerida
1. En staging real, cargar desde iPhone y Android una fotografía de **entre 2 y 12 MiB** con EXIF GPS conocido en **ambos** formularios; comprobar envío de un único JPEG <=512 KiB, recuperación íntegra, orientación visual y ausencia de metadata fuente. Rechazar fotos >12 MiB antes de lectura y PDFs >2 MiB.
2. Repetir cuando falla la decodificación o el almacenamiento, y después de cambio de cuenta durante conversión: no debe enviarse ni decir "adjuntado".
3. En el parte, perder el ACK HTTP después de creación y reintentar: un solo asset, mismo ID, contenido íntegro y contador igual.
4. Validar PDFs con consentimiento informado sobre su posible metadata y dar seguimiento a la política del backend.
5. No marcar release GO: permanecen hallazgos de imágenes (0P.29), staging, backups externos, QA físico y aprobaciones de #130.

No se modifican API, RLS, migraciones, Docker ni secretos.
