# CI OCI — importación independiente de imágenes firmadas (#259)

## Incidente confirmado

En el push independiente de `main@1e966072c7e97614b0a02ae7fbc5470de766c4ed` (PR #258), [GitHub Actions #40864603592](https://github.com/FedesConsultora/SedeAgro/actions/runs/40864603592) mostró 6/7 jobs en PASS, pero `offline-image-import` falló en dos intentos al ejecutar `ci-oci-import-rehearsal.mjs --mode fresh`. Antes del fallo se verificaron el TAR, el receipt, las firmas Sigstore de GitHub y los hashes de evidencia de seguridad. El wrapper OCI oculta detalles de Docker por seguridad, así que no atribuir el fallo a una causa interna concreta no demostrada.

El 29/10 GitHub movió `ubuntu-latest` a Ubuntu 26.04; otra CI exact-head #40863850654 falló en Playwright 1.58.2 y la generación de paquete OCI usando ese entorno. Los runners de imagen productora y Chromium se fijaron en Ubuntu 24.04 en el PR #258 y el PR exact-head aprobó 5/5; el consumidor OCI había quedado en `ubuntu-latest`.

## Cambio controlado

`offline-image-import` ahora usa explícitamente `ubuntu-24.04`, igual que `production-images`. Permanece como job independiente con daemon Docker propio, desencadenado exclusivamente por push a `main` y dependiente de `production-images` y `attest-oci-bundle`. Se mantiene todo el protocolo: checkout del SHA exacto, descarga de TAR y receipt inmutables, verificación de firmas OIDC/Sigstore, validación de hallazgos Syft/Trivy, importación sin red externa a daemon disposable, comparación de imagen/layers, ensayos Compose y creación de contenedores sin ejecutar servicios ni desplegar.

`scripts/test/pilot-ci-runner-compat.test.mjs` ahora exige runner Ubuntu 24.04 en **cuatro** gates (dos Chromium, productor OCI e importador) y verifica que no se hayan eliminado las comprobaciones de firmas o importación. No se desactivan seguridad, SHA/diffID checks, ni se cambia el verificador para que acepte datos falsos.

## Prueba y riesgos

Antes de cierre exigir CI exact PR HEAD 5/5, merge normal y CI independiente push/main 7/7 incluyendo el importador. Si el consumidor falla de nuevo con runner fijado, queda bloqueado sin workaround de seguridad: se requiere diagnóstico de importación en ambiente aislado. Las pruebas de CI no implican staging productiva ni aceptación física; #130 sigue NO-GO, con #232 y #163 pendientes.
