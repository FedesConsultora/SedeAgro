# PILOT-SCOUT-VIEWER — Vista previa y descarga privadas, acotadas por sesión

## Defecto funcional detectado

Antes de este bloque, la vista previa de evidencias de recorrida llamaba `getEvidenceContent`, ejecutaba `atob` directamente y abría una URL `blob:` sin verificar que el ID, MIME, nombre y tamaño recibidos coincidieran con la evidencia seleccionada. La descarga desde `ScoutingPage` también ejecutaba `atob` sin límite propio ni comprobación de identidad. Una respuesta retrasada podía disparar la descarga después de que el usuario cambiase de empresa o abandonara la recorrida.

El backend desde PR #182 comprueba SHA-256 y tamaño antes de emitir bytes, pero sigue siendo necesario un **segundo límite de confianza en el navegador**: el servidor puede responder con otro objeto o una respuesta puede pertenecer a una solicitud obsoleta. Esto no demuestra que se haya filtrado un archivo en producción; previene la posibilidad.

## Comportamiento corregido

1. `parseScoutingPrivateEvidence(response, selected)` compara **ID UUID seleccionado, tipo MIME, nombre seguro y longitud de bytes**, reutilizando el decodificador acotado `decodePrivateEvidenceResponse` (Base64 canónico, <=2 MiB) ya probado para evidencias de órdenes.
2. Los MIME de imagen `image/jpeg`, `image/png`, `image/webp` pueden verse en el modal; un PDF válido se descarga, pero no se inserta en `img`. No se admiten URLs externas, HTML ni SVG.
3. El modal deriva una clave de `sessionScope`, rol, entitlements, recorrida, ID de evidencia y metadatos; un cambio de cuenta/rol/recorrida, cierre del modal, pestaña oculta, `pagehide` o evento `offline` invalida la solicitud y revoca inmediatamente las URLs `blob:` que pertenecen a ese modal. Los bytes tardíos no se convierten en imagen visible.
4. La descarga se bloquea síncronamente ante doble clic; sólo activa el ancla de descarga si el ticket y scope original siguen vigentes **después** de recibir y validar el blob. El cambio de sesión, el cierre de la vista o la pérdida de conectividad invalidan operaciones pendientes y revocan la URL.
5. Respuestas incompletas, Base64 inválido, MIME sustituido, nombre inconsistente, tamaño alterado, UUID ajeno o fichero legado con nombre inseguro se rechazan, sin mostrar ni descargar bytes; el usuario recibe un error recuperable.

## Tests y aceptación

`frontend/test/scoutingPrivateEvidenceClient.test.js` incluye positivos para JPEG/PNG y PDF, matriz negativa de UUID, MIME, nombre, bytes, Base64 malformado/sobredimensionado, rutas en nombres antiguos, y comprobación del cableado de ambas interfaces, sesión, invalidación y `URL.revokeObjectURL`.

Pruebas físicas pendientes en staging TLS autorizado: vista previa y descarga de JPEG/HEIC convertido en iPhone y Android; cambiar de cuenta mientras la petición está en vuelo; ocultar pestaña con imagen abierta; perder red; doble tap en Descargar; revocar permisos mientras carga. Confirmar cero descargas después de pérdida de autoridad y que los objetos `blob:` son liberados. No marcar estos ensayos PASS por un test de Node/Chromium en CI.

## Límites

No se modifica el contrato REST, RLS, blobs, validación SHA-256 del backend, almacenamiento cifrado offline, límites de cámara ni lógica de partes de órdenes. No se reemplaza la aceptación de dispositivo. MOB-05 #163, rendimiento staging #143 y el release GO/NO-GO #130 continúan pendientes.
