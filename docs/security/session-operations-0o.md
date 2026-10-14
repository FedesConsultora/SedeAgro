# Bloque 0O — Control de sesiones y entrega reproducible de staging

## Funcionalidades integradas

**Cinco sesiones simultáneas por usuario y empresa.** Cada login, incluidas solicitudes paralelas, bloquea transaccionalmente la fila `users` con `FOR UPDATE` antes de leer `auth_sessions`. Si ya existen cinco sesiones vigentes, se revoca la más antigua antes de insertar la nueva. No hay una carrera entre procesos API que permita superar el tope. El máximo se aplica por `tenant_id:user_id`, no sobre todas las empresas del usuario. Las sesiones revocadas se rechazan en la siguiente solicitud HTTP, aunque su JWT aún no haya vencido.

**Panel Seguridad de sesiones.** Disponible a cualquier usuario autenticado desde el menú lateral. `GET /api/v1/auth/sessions` expone solamente ID aleatorio de sesión, creación, vencimiento y cuál es la actual; nunca tokens, contraseñas, agente de usuario o IP. `DELETE /api/v1/auth/sessions/:sessionId` permite revocar únicamente otra sesión activa **del mismo usuario y tenant**, bajo RLS y autorización; la sesión actual se cierra por `POST /auth/logout`. La cookie exige el marcador de protección CSRF para revocaciones.

**Origen único para cookies.** El frontend usa `/api/v1` como URL base por defecto; Nginx la redirige dentro de Docker y Vite habilita un proxy de desarrollo. Ya no se construyen llamadas hacia `http://localhost:3001` desde el navegador de un usuario en staging. Una variable `VITE_API_URL` definida para staging debe ser una ruta `/api/...` del mismo origen y se valida al generar el manifiesto. HTTPS del borde y `Secure` continúan siendo obligatorios en un staging real.

## Limpieza segura y retención

`backend/scripts/cleanup-auth-sessions.mjs` permite **solo a un propietario real de `auth_sessions`** limpiar filas revocadas/vencidas con más de **30 días**. No se ejecuta automáticamente en las solicitudes de usuario. Predeterminado: lectura de conteos sin borrar nada.

Comandos, desde el directorio `backend/`, usando `DATABASE_URL` **del propietario de staging** configurado mediante un medio seguro (no en argumentos CLI):

```bash
node scripts/cleanup-auth-sessions.mjs --dry-run
CONFIRM_AUTH_SESSION_CLEANUP=DELETE_EXPIRED_SESSIONS node scripts/cleanup-auth-sessions.mjs --apply
```

`--apply` exige autorización literal, rol propietario y elimina **como máximo 500** filas por ejecución, usando `FOR UPDATE SKIP LOCKED` para evitar bloquear otras tareas. No elimina ninguna sesión activa. Revisar backups y conteos antes de aplicar en producción. Para limpieza periódica futura, incorporar scheduler con reportes, aprobaciones y monitoreo explícitos; este PR **no** activa borrados programados ni ejecuta el CLI en VPS.

## Gates de aceptación

- PostgreSQL/PostGIS real: seis inicios de sesión simultáneos más uno secuencial, límite cinco, JWT antiguo bloqueado, consulta propia, revocación de otra sesión, intento de cerrar la propia desde el endpoint incorrecto, repetición y aislamiento. Continúan los tests de RLS, cookies, CSRF, observaciones/evidencias y roles.
- **Chromium + backend real:** React registra cuenta mediante API real y comprueba cookie HttpOnly/SameSite, ausencia de JWT en LocalStorage, recuperación después de recargar, login en otro contexto, revocación desde el panel y logout final. Crea y borra únicamente datos de una base disposable `*_test`.
- Chromium offline independiente: IndexedDB cifrado, migración antigua, cámara, EXIF y shell. Nginx se valida por HTTP real.
- Artefacto de staging: `scripts/staging-release-manifest.mjs create|verify` enumera de manera estable `frontend/dist`, calcula SHA-256, guarda SHA de `git HEAD`, tamaños y nombres, y falla ante diferencias. GitHub Actions publica `sedeagro-staging-<SHA>` **solo después de un push a main con CI aprobado** (retención 14 días). La existencia de este artefacto no demuestra que un VPS lo haya descargado o servido.

## Runbook de staging sin automatizar despliegue

1. Congelar la versión exacta de `main` y obtener el artefacto `sedeagro-staging-<SHA>` cuyo CI de **push** está verde; comprobar la correspondencia de los SHA de código, release manifest y contenido extraído. No mezclar archivos de PRs o builds previos.
2. Crear backup consistente de staging; verificar `pg_restore --list` y **probar restauración en una base disposable**. Documentar roles owner/runtime y RLS FORCE. Capturar evidencias sin tokens ni datos personales.
3. Aplicar migraciones autorizadas con usuario propietario y con período de mantenimiento, especialmente `auth_sessions` del bloque anterior; actualizar los servicios de backend/frontend de manera coordinada. Nunca montar base de producción desde staging ni reutilizar secretos.
4. Verificar TLS, cookies `Secure;HttpOnly;SameSite=Strict`, `/health`, protección anónima, CSP, RLS de dos tenants y la política de cinco sesiones en **staging**, usando `scripts/verify-pilot-staging.sh` como chequeo inicial read-only (no verifica el SHA servido).
5. Realizar la matriz `docs/pilot-field-acceptance-0l.md` sobre Android y iOS físicos; ensayar reconexiones, cuotas offline, fotos, revocación de sesión y pérdida de confirmación.
6. Aprobar únicamente si los gates críticos quedan en `PASS` con responsable y registro. Definir estrategia de rollback **antes** del despliegue: revertir frontend/backend sin compatibilidad de esquema puede dejar sesiones inválidas, y restaurar DB puede perder datos creados tras el backup.

### Limitaciones conocidas

Los navegadores offline no pueden validar una cookie nueva o revocada sin recuperar conexión. Los borradores cifrados de ese dispositivo siguen conservados, pero la aplicación no debe presentarlos como registros confirmados sin servidor. La gestión de sesiones no recopila ubicación, tipo de dispositivo ni huella del navegador. La cookie limita la extracción directa del JWT por scripts; **no previene XSS ni todo abuso del mismo origen**. El CLI no está programado para ejecutarse solo y el pipeline no despliega al VPS.
