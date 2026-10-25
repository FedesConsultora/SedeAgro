# Piloto SedeAgro 0.1 — ingreso seguro con múltiples empresas

**Cadena:** empresa → usuario/membresía/rol → elección de empresa → sesión activa. Base `main@33e62df34d957c25eb8e8b4757b8a1f31dd66eb2`, coordinación #18, matriz #166. Release #130 sigue **NO-GO**.

## Defecto que existía en el código

`LoginPage.jsx` dependía de `loading` React para impedir dos envíos `POST /auth/login`. Dos eventos antes del siguiente render podían producir solicitudes superpuestas y sesiones/cookies distintas. Al recibir `requiresTenantSelection` renderizaba `memberships` sin comprobar UUID, slug, nombres, rol o duplicados, y el paso de selección leía el estado editable del formulario sin un snapshot de la solicitud inicial. Una respuesta exitosa de selección tampoco se cotejaba con la empresa elegida antes de invocar el inicio de sesión.

La ruta Express ya valida usuario/contraseña, membresías activas y genera cookie HttpOnly. Este bloque **no reemplaza el backend**: protege la coherencia del flujo de acceso dentro de una pestaña.

## Implementación

1. `createLoginAttemptGate()` hace adquisición síncrona de una solicitud antes del primer `await`. Una pulsación doble no emite dos solicitudes; no se empieza un nuevo login mientras hay una selección de empresa pendiente.
2. El par de acceso se normaliza y congela **sólo en memoria**, sin datos de acceso en URL, almacenamiento local, sesión ni logs. Los campos quedan inhabilitados mientras corre el request o se elige empresa.
3. La respuesta con múltiples empresas se valida: array no vacío y razonablemente acotado, ID UUID, slug seguro, nombre y rol no vacíos, sin IDs o slugs repetidos. Se muestra una lista generada exclusivamente por el backend autenticando esas credenciales.
4. Sólo un slug recibido en esa respuesta puede comenzar la segunda solicitud, usando el mismo par de acceso inicial y `tenantSlug` seleccionado. Otro clic simultáneo queda bloqueado.
5. Para marcar sesión iniciada se requiere que el servidor confirme usuario/identidad, empresa, membresía, rol y entitlements. En el segundo paso debe devolver exactamente **tenantId, tenantSlug y roleCode** de la selección. Una respuesta incompatible muestra error, nunca llama `login()`.
6. Volver desde la selección borra el secreto ingresado, descarta la lista y exige un nuevo inicio. Ante rechazo 401/403 al seleccionar empresa se reinicia el flujo; un error de red permite reintentar la misma opción explícitamente. Los resultados de un intento invalidado o componente desmontado no completan otro.
7. No se alteran endpoints, sesión HttpOnly, autenticación del backend, FORCE RLS, CORS, permisos, política de contraseñas ni persistencia de borradores offline.

## Pruebas

`frontend/test/loginAttemptSafety.test.js` prueba doble envío, validación estricta de elecciones, asociación entre empresa seleccionada y ACK del servidor, cambio de rol, respuesta tardía de intento cancelado, fallo recuperable del paso 2, selección repetida, contexto de memoria y wiring del formulario.

## Aceptación pendiente

- Cuenta con una sola membresía: respuesta de sesión y entrada directa correctas.
- Cuenta con dos empresas y roles distintos: lista de opciones; doble clic genera un solo request, la segunda respuesta coincide con tenantId/slug/role y la aplicación abre el tenant elegido.
- Simular error de red, 401 o 403 en la segunda petición, volver a iniciar y probar que no se muestran empresas previas ni se reutilizan credenciales anteriores tras volver.
- Probar sesión revocada/rol cambiado y cambio de pestaña frente a cookie HttpOnly; el servidor conserva su autoridad. La UI **no puede garantizar** ausencia de Set-Cookie en una respuesta que el navegador ya haya procesado.
- Validar con Android/iOS reales y cuenta piloto de staging; **NOT_RUN**.

El CI de unidad/React/Chromium/PostGIS es condición técnica para merge, no acredita login físico ni GO productivo. No desplegar sin autorización.
