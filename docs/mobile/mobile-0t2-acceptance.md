# SedeAgro — 0T.2 Captura móvil y aceptación del piloto (15/10/2026)

## Qué cambia y por qué

El código de campo anterior ya cifraba borradores AES-GCM, convertía
todas las fotos nuevas a JPEG para quitar EXIF/GPS, limitaba el payload a
512 KiB y obtenía GPS solo con clic voluntario. Esas garantías se mantienen.

### 1. Decodificador fotográfico compatible con más navegadores

`readOfflinePhoto` usa primero `createImageBitmap` con orientación declarada.
Si no existe o falla, intenta `HTMLImageElement` con un object URL temporal,
decodifica para Canvas y **siempre** crea un nuevo JPEG. Revoca el object URL
en éxito y error; rechaza timeout de decodificación, dimensiones inválidas,
más de 40 MP y formatos no admitidos. Jamás guarda la foto original sin
re-codificar por el mero hecho de pesar menos de 512 KiB.

El fallback amplía cobertura de navegadores, **no certifica** manejo correcto
de orientación EXIF en Safari físico: la orientación renderizada por un elemento
HTML depende del motor/dispositivo. MOB-02 requiere comparación visual con
fotos retrato/paisaje y cámara trasera real.

### 2. GPS suspendido

Una petición de `getCurrentPosition` no tiene cancelación nativa. Cuando
la página pasa a `hidden` o emite `pagehide`, el formulario invalida el
identificador de la petición, libera el estado de carga, descarta una respuesta
tardía y exige un nuevo clic si el operador desea adjuntar GPS. No usa
`watchPosition`, geocodificación silenciosa ni coordenadas persistidas fuera
del borrador elegido.

### 3. Carrera al preparar fotografías

`createMobileCaptureFence` protege la etapa de decodificación JPEG. Una
finalización tardía de una captura no se encola si ya cambió cuenta, modo,
recorrida, se cerró el modal o se desmontó. Envíos y registros que hayan
entrado en su transacción IndexedDB antes de la transición siguen regidos
por el aislamiento por tenant, CAS y los ACK de 0S.10–0S.18. El fence
**no equivale** a cancelar transacciones de almacenamiento ya iniciadas.

## Matriz: pruebas automatizadas vs aceptación física

Los IDs se corresponden con `docs/pilot-field-acceptance-0l.md`.

| ID | Automatización adicional 0T.2 | iPhone/Android físico |
| --- | --- | --- |
| MOB-01/02 | Chromium viewport 390 × 844, decodificación por Image sin createImageBitmap y JPEG nuevo | NOT_RUN: cámara, orientación, Safari real |
| MOB-03/11 | Gates existentes de 12 MiB, 40 MP, 512 KiB, HEIC denegado | NOT_RUN: memoria, HEIC, rendimiento físico |
| MOB-04/05 | Nuevo JPEG con EXIF de prueba se cifra en IndexedDB y se abre tras reload; pruebas offline shell existentes | NOT_RUN: modo avión, cierre de app del teléfono |
| MOB-06/07 | Gates existentes con ACK idempotente y recuperación fotográfica | NOT_RUN: red rural, pérdida de ACK en hardware |
| MOB-08 | Fence por cuenta/recorrida; aislamiento cifrado multi-tenant ya probado | NOT_RUN: cambio de cuenta durante conversión pesada real |
| MOB-09 | Límite y preflight de storage existente; fallos honestos | NOT_RUN: Safari eviction/cuota insuficiente |
| MOB-10 | GPS opt-in; `pagehide` con respuesta posterior ignorada en navegador auténtico | NOT_RUN: permisos cámara/GPS de SO |
| MOB-12 | Re-encoding en fallback, no hay señal EXIF privada en JPEG final ni IndexedDB visible | NOT_RUN: foto EXIF de dispositivo y metadata inspeccionada |

El navegador emulado no es Safari ni iOS físico. Los PASS automatizados
se registran exclusivamente al finalizar CI del PR sobre su HEAD exacto.
No se ha desplegado la aplicación ni se han tomado evidencias móviles
reales en este bloque.

## Instrucciones para ejecución física posterior

Por cada dispositivo anotar marca/modelo, SO/build, versión del navegador,
fecha, conexión utilizada (Wi-Fi/datos/avión), orientación de imagen, tamaño
original/final, observación esperada y observada, estado PASS/FAIL/BLOCKED,
captura o video **sin datos privados**, y referencia a un único issue de falla.
No publicar fotos, coordenadas, JWT, identificadores de tenant ni capturas
privadas en GitHub. Preferir un entorno staging descartable con cuentas y
lotes sintéticos.

Fallas bloqueantes: contenido de cuenta ajena, falso guardado, EXIF sin
sanitizar en nuevas fotos, foto/observación duplicada, un GPS tardío
adjuntado sin consentimiento, pérdida silenciosa de borradores y error que
se disfraza de respuesta vacía. No promover producción sin resolverlas.

## Gates técnicos

- Tests unitarios `frontend/test/mobileCaptureSafety.test.js`.
- Playwright Chromium `frontend/test/offlineBrowser.mjs`: fallback,
  JPEG sin EXIF, URL revocada, AES-GCM y recarga.
- Aceptación real Express/PostGIS `scripts/acceptance-browser-evidence-history.mjs`:
  respuesta GPS posterior a pagehide, sin coordenadas reactivadas.
- Regresiones existentes de tenant RLS, cookie, offline y staging.
- Aceptación física Safari/iOS, Android, QA rural y staging sigue
  explícitamente PENDIENTE (0T.2 de dispositivo / 0T.3 release gates).
