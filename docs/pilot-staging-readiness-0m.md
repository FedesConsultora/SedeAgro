# Bloque 0M — Privacidad de fotografías y preparación operativa del piloto

## Implementado en el repositorio

### Fotografía sin metadatos incrustados nuevos
- **Toda fotografía offline nueva**, incluso de tamaño menor a 512 KiB, se decodifica con `createImageBitmap` o, cuando no está disponible, con un elemento de imagen temporal y se **recodifica a JPEG mediante Canvas** antes del cifrado local. Nunca copiamos el archivo fuente como evidencia offline. Esto evita reenviar su bloque EXIF/GPS/IPTC original y minimiza filtraciones de ubicación por metadatos; no garantiza anonimizar lo visible en la propia imagen.
- Se siguen imponiendo 12 MiB de origen, 40 megapíxeles decodificados y 512 KiB de resultado; escalas y calidad siguen controladas. Si falla Canvas/decodificación/re-codificación, el guardado con foto falla explícitamente y no se afirma que fue persistida.
- Fotos PNG transparentes se aplanan contra blanco y pueden cambiar ligeramente de color/calidad; existe una vista previa del **archivo original** (no del JPEG finalmente generado), de modo que una aceptación en dispositivos físicos debe revisar diferencias visuales.
- Los borradores antiguos cifrados en IndexedDB **no se modifican ni reprocesan automáticamente**: ya tienen claves/IDs inmutables para preservar la idempotencia. Deben enviarse con consentimiento informado o eliminarse manualmente si la política local prohíbe metadatos.
- Archivos subidos desde otros endpoints online y PDF **NO** se recodifican automáticamente en este bloque; esas rutas necesitan una política separada de seguridad y retención.

### Frontend de producción y seguridad de origen
- `frontend/nginx.conf` publica CSP de **scripts y conexiones solo del origen**, bloquea `object-src`, el framing, formularios externos y bases de documento arbitrarias. Permite `blob:` en `img-src` para vista previa y CSS en línea por estilos React existentes; se debe reemplazar `style-src 'unsafe-inline'` antes de considerar la CSP estricta definitiva.
- Headers: `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Permissions-Policy`, `Cross-Origin-Resource-Policy`.
- **Las fuentes externas de Google se retiran del HTML**. Se priorizan fuentes de sistema: el shell de campo no depende de una consulta a terceros y la CSP de producción puede usar `font-src 'self'`.
- `index.html` y `sw.js` deben revalidarse (`Cache-Control: no-cache`) mientras los activos Vite con hash reciben caché prolongada; el service worker sigue guardando únicamente recursos públicos del shell.
- **TLS/HSTS pertenecen al proxy de borde** de staging/producción; este Nginx corre por HTTP solo dentro de Docker. No afirmar que CSP o el AES local impiden XSS, robo de JWT accesible desde JS o compromiso del perfil del dispositivo. Desde 0N las sesiones web usan cookies HttpOnly/SameSite=Strict y Secure en producción. LocalStorage conserva solo una pista no secreta de tenant. Falta la certificación de cookies y CSRF en staging. No copiar tokens a logs ni a informes.

## Comprobaciones automatizadas
- `npm --workspace frontend run test`: política de foto, límites, AES-GCM, cola e idempotencia.
- Playwright Chromium: crea JPEG pequeño con marcador EXIF/GPS, asegura que no reaparece en el JPEG re-codificado, y conserva los smoke tests de foto grande, IndexedDB v1→v2 y reinicio sin conexión.
- CI usa `nginx:1.27-alpine` para `nginx -t`, arranca la configuración real con el build Vite, comprueba CSP/headers, no-cache del HTML/SW, caché de archivos con hash y rutas SPA. Las pruebas PostGIS/RLS continúan sin alteraciones.
- El gate de despliegue en staging está disponible como `scripts/verify-pilot-staging.sh`. Solo lee estado de HTTPS y realiza consultas públicas sin credenciales. **No constata por sí solo el SHA realmente servido por el VPS**. El validador de 0T.3 permite comparar hashes de bytes servidos del frontend contra el manifiesto confiable de CI, pero tampoco certifica digest de API ni restablecimientos de base de datos.

## Procedimiento staging manual, sin ejecución automática

1. Registrar ticket de cambio, responsable, entorno, dominio, hora y **SHA exacto de `main`** aprobado por CI; congelar modificaciones simultáneas y decidir cómo notificar a usuarios piloto.
2. Comprobar que la infraestructura de staging está aislada de producción, con credenciales propias, `NODE_ENV=production` y `SEED_MODE=prod`. Confirmar ausencia de cuentas demo y secretos comunes. No publicar PostgreSQL/Redis en interfaces externas.
3. Crear **backup consistente antes de migrar** desde el propietario autorizado: `pg_dump --format=custom --no-owner --no-acl --file=staging-before-0m.dump` usando un entorno controlado y credenciales suministradas fuera de la línea de comando. Guardar cifrado fuera del VPS, verificar que el archivo se abre con `pg_restore --list staging-before-0m.dump`, registrar checksum SHA-256 y retención.
4. Probar **una restauración de ese backup en una base disposable distinta**. Este paso se hace por DBA, con cuidado de roles RLS, extensiones PostGIS, funciones y permisos. Registrar que el sistema arranca con el restaurado. No afirmar backup comprobado solo por crear un archivo.
5. Construir e instalar el artefacto inmutable del SHA aceptado; migraciones solo con rol propietario, API con rol de mínimo privilegio. Usar `docs/security/postgres-rls-runbook.md` y el `scripts/deploy-prod.sh` únicamente cuando corresponda al entorno correcto, nunca apuntarlo accidentalmente a producción.
6. Ejecutar desde el checkout correspondiente, y comparar también los bytes realmente publicados con `node scripts/verify-deployed-staging.mjs --url https://staging.example.com --sha SHA40 --manifest staging-release-manifest.json` del CI aprobado: `bash scripts/verify-pilot-staging.sh https://URL-STAGING SHA-COMPLETO`. Comprobar también sesiones permitidas, aislamiento de dos tenants, identidad/rol del usuario, recibos y upload real sin credenciales compartidas.
7. Completar evidencias MOB-01..MOB-12, SEC-01..SEC-02 y OPS-01..OPS-02 de `docs/pilot-field-acceptance-0l.md` en **Android/iOS reales**. Guardar versión de navegador, hora, evidencias anonimizadas, responsable, severidad del defecto y `PASS/FAIL/BLOCKED/NOT_RUN`.
8. Definir rollback: cortar escrituras/tráfico, restaurar la **misma imagen de aplicación y versión de esquema compatibles**, recuperar datos desde backup solo con autorización explícita y considerar operaciones de campo creadas después del respaldo. Verificar las operaciones offline que pudieron quedar pendientes en los equipos; una reversión mal planificada puede producir pérdida de datos.
9. Go/no-go: ningún incidente de aislamiento, login, exposición de notas/fotos, duplicación o pérdida de cola queda abierto. Todos los gates críticos deben ser `PASS` con firma de responsable. Una prueba automatizada verde **no** equivale a aprobación de piloto.

## Riesgos pendientes y límites

- Sin pruebas físicas en iOS/Android ni restauración real en un VPS de staging.
- Cookies HttpOnly y protección CSRF implementadas en el código desde 0N, **no certificadas en staging real**. La CSP mitiga parte del riesgo de inyección pero **no lo elimina**.
- CSP acepta estilos inline por compatibilidad actual. El proxy TLS externo debe establecer y revisar HSTS/forwarded headers.
- Fotos existentes o cargas online pueden contener EXIF. No se ha realizado escaneo antivirus ni eliminación de archivos sensibles en servidor.
- Calidad del JPEG, orientación, cámara, HEIC/HEIF, permisos y cuota de dispositivos físicos no certificados.
- Ningún despliegue automático ni migración de base de datos se realiza en el Bloque 0M.
