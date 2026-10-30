# MOB-05 / 0U — Carreras de identidad en el acceso local cifrado

**Fecha:** 30/10/2026. **Base:** `main@0d7efd3b68ed67d0853e65e15b5e99aefd845b74`. **No equivale a certificación en dispositivos Android/iOS físicos ni staging; release #130 NO-GO.**

## Riesgo: limpieza anterior termina después de un alta nueva

`SessionContext` cierra la vista privada y bloquea la capacidad local inmediatamente, pero `clearOfflineFieldVault()` abre IndexedDB de forma **asíncrona**. La anterior limpieza podía llegar a `objectStore.delete('active')` después de que el operador entrara con otra cuenta y preparara un nuevo vault cifrado. En tal secuencia, el registro nuevo podía desaparecer aunque estuviera bien autorizado. El borrado de borradores/cola no estaba involucrado; el registro afectado es sólo el sobre AES-GCM `active` de la base `sedeagro-field-offline-vault`.

La misma carrera, en sentido opuesto, permite que una derivación PBKDF2 iniciada por un actor anterior continúe hasta `store.put(sealed)` cuando su sesión ya cambió. Una lectura/decrypt pendiente de `unlockOfflineFieldVault` también debe rechazar el resultado tras un bloqueo.

## Contrato implementado

1. **Epoch en memoria para una instancia/pestaña:** `lockOfflineFieldVault()` incrementa y devuelve la generación de capacidades. Un nuevo enrolamiento invalida limpiezas y enrolls anteriores *antes* de ejecutar PBKDF2.
2. **Fencing de escritura:** se comprueba que la generación siga vigente después de cifrar, nuevamente **dentro de la callback del IDB transaction después de esperar `indexedDB.open()`**, y al finalizar el commit. Si cambió, el enrolamiento viejo falla y no escribe una identidad obsoleta.
3. **Fencing del borrado:** `clearOfflineFieldVault()` bloquea inmediatamente y captura su generación. Si cuando el objeto store abre hay una generación nueva, la limpieza vieja finaliza sin borrar el sobre de la sesión más reciente. Si sigue vigente, se borra normalmente. No afecta `sedeagro-offline-sync` ni las fotos cifradas.
4. **Fencing de lectura:** el desbloqueo revalida generación después del GET local y de la derivación criptográfica. Una prueba de contraseña ya superada no otorga acceso si la identidad cambió mientras esperaba.
5. Sin credenciales persistidas, sin nuevas llamadas HTTP, sin relajación del RLS ni tokens de autorización offline.

## Pruebas reproducibles

- `frontend/test/offlineVaultEpochRace.test.js`: stub de IndexedDB con apertura diferida y operaciones transaccionales. Prueba que un `clear` viejo iniciado antes del enrolamiento de una nueva cuenta no borra su sobre cifrado; que el borrado actual sí funciona; que el `put` de una cuenta antigua se rechaza tras `lock`; y que un `unlock` pendiente no recupera una capacidad después de cambiar la generación.
- `frontend/test/offlineFieldVault.test.js`: contrato de implementación de los fences dentro de transacción y ausencia de fetch/almacenamiento de credenciales.
- Gates obligatorios sin skips: `tenant-rls`, `browser-postgis`, `browser-offline`, `dependency-security`, `production-images`; después del merge, verificación independiente de main.

## Límite de seguridad y pruebas de aceptación pendientes

La generación es **local a cada contexto JavaScript**. Los cambios de sesión entre pestañas se propagan por el canal existente de sesión, pero esta modificación **no pretende probar atomicidad global entre dos procesos/pestañas desconectados** ni escenarios de cierre forzado de Safari. Esos casos, junto con restricciones de espacio, permiso de almacenamiento persistente, 48 horas, cambio de cuenta y borradores antes/después de logout/revocación, siguen en #163 y #166 para la matriz física Android/iOS.

La capacidad offline sólo abre borradores locales de una identidad previamente verificada y nunca sustituye sesión/permiso HTTP. Sin staging ni deploy.
