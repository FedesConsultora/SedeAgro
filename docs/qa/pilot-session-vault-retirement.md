# Piloto 0.1 — retiro de acceso offline al revocar sesión

**Ámbito:** frontend/auth + vault local MOB-05 (#163), aceptación de actores (#166). **Release #130: NO-GO.**

## Incidente de código y corrección

Antes de este cambio, la función `logout` ejecutaba `await api.logout()` y **después** `await clearOfflineFieldVault()` dentro del mismo `try/catch`. Si el servidor ya había revocado la cookie pero IndexedDB rechazaba el borrado, se saltaba `setSession(null)`, no se publicaba el cambio de cuenta a las otras pestañas y se mostraba erróneamente «No se pudo cerrar sesión en el servidor». El evento `sedeagro:session-expired` sí exigía que la respuesta `401` correspondiera al usuario/tenant y a la generación actual, pero no retiraba explícitamente el sobre de acceso local opt-in.

El contrato nuevo separa la autoridad remota del almacenamiento local:

1. **Error en API de logout:** no se afirma que el servidor haya revocado la sesión; la UI conserva el estado y avisa que debe reintentarse.
2. **ACK correcto de logout:** se bloquea inmediatamente la capacidad de acceso offline en memoria; **antes de esperar a IndexedDB** se retira la sesión de React, se cambia a modo sin datos privados y se notifica a las demás pestañas.
3. **Borrado de IndexedDB correcto:** sin aviso adicional. **Borrado rechazado:** la UI igualmente se cierra, pero muestra un aviso explícito para eliminar los datos del sitio antes de compartir el dispositivo. El sobre cifrado podría permanecer recuperable offline; no se promete su eliminación.
4. **401 vigente:** sólo si coincide scope + `authEpoch`, retirar la capacidad local e intentar borrar el sobre; después invalidar sesión actual y publicar la transición. Un `401` demorado de otra generación no revoca un login nuevo.
5. Ninguna de estas operaciones elimina los borradores de observaciones, GPS o JPEG: sólo afectan la credencial de recuperación local `sedeagro-field-offline-vault`. Sin bypass de login, RLS, cookies ni permisos de backend.

## Regresiones

- `frontend/test/offlineVaultRetirement.test.js`: bloqueo previo al borrado, retorno positivo/negativo e IndexedDB pendiente sin dejar abierta la capacidad.
- `frontend/test/sessionTabWiring.test.js`: logout confirmado no se confunde con error de storage, cierre y aviso de tabs antes de esperar borrado; handler de 401 usa primero `isCurrentSessionExpiry`.
- `frontend/test/offlineFieldVault.test.js`: comprueba que el acceso se retira mediante la función central sin pasar por una sesión autenticada falsa.
- Ejecutar `npm --workspace frontend run test` y build, Chromium offline y gates PostgreSQL/seguridad normales de la PR. No tratar un test de lectura de código como sustituto de E2E.

## Ensayo físico pendiente

Con un scout real en staging privado autorizado: preparar vault mientras está conectado y autenticar, cerrar sesión voluntariamente y confirmar desaparición de vistas de empresa en dos pestañas; reiniciar sin red y comprobar que no se ofrece un acceso local previamente retirado; repetir con sesión revocada vía otro dispositivo y reconexión 401. Para la rama de error local usar un navegador/almacenamiento descartable sin datos reales: forzar fallo de borrado de IndexedDB y confirmar que logout HTTP **sí** termina la sesión, desaparecen vistas privadas y aparece advertencia de limpiar datos del sitio. Verificar luego limpieza manual y no revelar fotos, credenciales ni notas en logs.

**No se ha ejecutado** staging, Android Chrome ni iOS Safari por este bloque. Security Owner debe revisar el riesgo de sobre local recuperable si el borrado físico falla. La CI de esta PR no certifica revocación sin conectividad, aceptación humana ni autorización para deploy.
