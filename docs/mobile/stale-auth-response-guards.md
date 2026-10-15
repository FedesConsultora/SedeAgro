# 0S.17 — Rechazo de respuestas tardías y expiraciones cruzadas de sesión

## Problema real

Antes del bloque 0S.17, cualquier respuesta 401 de `createApiClient` emitía un evento global `sedeagro:session-expired` sin identidad. Si el operador cerraba sesión, iniciaba otra cuenta (o volvía a ingresar a la misma) y una petición anterior devolvía 401 después, ese evento podía desalojar **la sesión nueva**, aunque la petición perteneciera a una sesión anterior.

Esto era independiente de los controles de red de 0S.15: cancelar `AbortController` evita muchas solicitudes pendientes de un panel, pero no cubre cualquier solicitud autenticada de la aplicación ni garantiza que un 401 llegue antes del cambio de identidad.

## Solución

El cliente API ahora emite exclusivamente `CustomEvent('sedeagro:session-expired', {detail:{scope,epoch}})` en los errores de autorización donde correspondía emitir el evento anterior.

- `scope`: exclusivamente `tenant.id:user.id` calculado por `sessionScope(session)`; no incluye JWT, cookies, secreto ni datos de las evidencias.
- `epoch`: identificador entero **local en memoria** para la generación de sesión. Aumenta en cada `setSession`, login, logout confirmado, restauración inicial o expiración. No se persiste ni se comparte como autenticación con el servidor.
- `SessionProvider` compara estrictamente el `scope` **y el epoch** del request original con el estado actual, leído de `sessionRef` y `authEpochRef` actualizados síncronamente en las transiciones. Si difieren, ignora ese evento viejo. Un 401 de la identidad actual sí invalida la sesión.
- Los eventos sin `detail` son tratados como no confiables; solo el cliente API real emite la notificación con contexto. El error HTTP igualmente se propaga al componente que lo inició y sigue aplicando los controles existentes de feedback.
- La restauración inicial del cookie desde `/auth/me` registra el epoch anterior al request; descarta éxito/error tardío si ya hubo login/logout/cambio de identidad. Evita otro camino de sobrescritura de cuenta por respuesta desordenada.
- No se modifican cookies HttpOnly, middleware de auth, políticas RLS, revocación en servidor, almacenamiento de evidencias ni sincronizaciones offline. El epoch **no** es mecanismo de autorización del backend.

## Pruebas

**Unitarias** `frontend/test/sessionExpiryScope.test.js`: 401 correcto, misma empresa/usuario con nueva generación, nuevo usuario, otra empresa, sesión anónima, evento sin scope/epoch, valor malformado.

**Browser real**: el gate existente `scripts/acceptance-browser-evidence-history.mjs` ahora demora **una respuesta 200 real** obtenida de Express mientras el usuario navega a Sesiones. Al liberarla tras desmontar el panel, confirma que no reaparece contenido privado. Vuelve a Monitoreo y valida una lectura nueva. Además inyecta dos **eventos de carrera de sesión** explícitos en el navegador (misma identidad y epoch viejo; otro tenant y epoch actual) y verifica que ninguno invalida la sesión activa. La expiración positiva de una cookie *realmente revocada en PostgreSQL* sigue siendo parte obligatoria del mismo gate de 0S.16: tras una petición 401 válida, React debe volver a Login y desmontar Monitoreo.

La demora de la respuesta usa Playwright `route.fetch` para obtener el resultado real del servidor y solo retrasa su entrega al navegador; no fabrica datos válidos. Los eventos de 401 viejo son estímulos locales de la prueba para ejercitar el handler; **no se presentan como solicitudes reales al backend**. Esto delimita exactamente qué se comprobó.

## Límites y aceptación pendiente

La protección elimina una carrera de invalidación client-side, pero **no reemplaza la revalidación de permisos de cada petición** en Express/PostgreSQL. Una respuesta autorizada antes de una revocación no se transforma retrospectivamente en no autorizada; al cambiar de vista/cuenta/desconexión el panel de evidencias aborta requests y descarta resultados tardíos por generación y scope. La pérdida física de señal LTE, cambio de SIM, Safari/iOS y Android siguen necesitando QA presencial.

Sin despliegue, nuevas dependencias, migraciones, cambios de RLS/ACL, escritura de notas/GPS/fotos ni pérdida de borradores IndexedDB. CI requerido: jobs `tenant-rls` y `browser-offline` SUCCESS **sobre el HEAD exacto** antes de merge normal.
