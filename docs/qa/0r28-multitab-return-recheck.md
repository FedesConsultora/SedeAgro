# 0R.28 — Aceptación de sesión entre pestañas tras volver a la empresa original

**Fecha:** 10/11/2026 · Coordinación #18 · Release #130 **NO-GO**.

## Fallo de CI observado

La verificación real de Chromium/PostGIS del PR #311, [run #42927955422](https://github.com/FedesConsultora/SedeAgro/actions/runs/42927955422), aprobó las pruebas de cierre de sesión global, adopción de otra empresa, control 503 de revalidación y aislamiento del panel de evidencias. Al iniciar de nuevo la sesión de la primera empresa en la segunda pestaña, la primera pestaña seguía en segundo plano. El test llamaba `bringToFront` y enviaba un evento `focus`, pero no siempre disparaba la revalidación: `getByTitle('Monitoreo').waitFor()` falló después de 14 segundos. No hubo prueba de fuga de datos o error confirmado de backend.

## Ajuste del escenario sin suplantar autenticación

El script `scripts/acceptance-browser-evidence-history.mjs` utiliza el mismo mecanismo de recuperación opaca de transición que ya requería al pasar de la empresa original a la segunda (líneas cercanas a 460):

1. La pestaña secundaria finaliza el login **real** HTTP/PostGIS y muestra «Sesiones».
2. Emite en `localStorage` un **nonce aleatorio** y un identificador de origen sin usuario, tenant, cookies, JWT, datos de evidencia ni sesiones.
3. La primera pestaña vuelve al frente, comprueba visibilidad y ejecuta el evento `focus`.
4. **Antes de mostrar navegación privada**, el test espera una respuesta **real** HTTP `GET /api/v1/auth/me = 200` desde la primera pestaña, no una respuesta interceptada ni inventada. Si el backend rechaza la sesión, la prueba falla.
5. Una vez revalidada la sesión, exige que «Monitoreo» aparezca, vuelva a abrir el lote original y recupere únicamente sus propias evidencias.

No se alargaron arbitrariamente los timeouts, no se eliminaron las aserciones 401/503, no se sustituyeron respuestas, no se cambió el comportamiento de auth de producción. El objetivo es reproducir el mecanismo de recuperación ante un evento perdido en una pestaña suspendida, no esconder una falla de autorización.

## Evidencia requerida

El resultado útil no es el commit, sino que `browser-postgis` complete **SUCCESS sobre el HEAD exacto** y que el mismo escenario pase posteriormente en la CI de `main`. Si falla la revalidación real o no vuelve la navegación, no corresponde fusionar otro bloque de seguridad ni declarar un release aprobado.

Este arreglo es únicamente de aceptación automatizada; todavía faltan pruebas en dispositivos reales y la aceptación de producción sigue **NO-GO**.
