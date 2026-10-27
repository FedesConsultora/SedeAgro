# P1 piloto — instalación atómica del shell offline (issue #249)

## Problema y límite de alcance

En el Service Worker anterior, una navegación online a `/` sobrescribía el HTML previamente instalado aunque referenciara bundles JS/CSS de otra versión que todavía no existían en CacheStorage. Si el operador volvía a abrir sin conectividad tras esa navegación, el HTML offline podía requerir archivos no cacheados. Además, ante una respuesta HTTP fallida en `install` se ejecutaba `skipWaiting`, dejando que una versión vacía reemplazara y eliminara un shell viejo válido.

**Este bloque evita esas condiciones; no desbloquea MOB-05 (#163).** Si se cierra el navegador y no se puede consultar `/auth/me`, la aplicación aún no restaura una identidad local, no permite leer borradores privados ni continuar capturas. Resolver eso exige diseño de seguridad, autorización y aceptación en dispositivos físicos. Nunca se usa `tenantHint` como prueba de autenticación.

## Comportamiento implementado

- `CACHE=sedeagro-web-shell-v3`: `install` obtiene el HTML público con `credentials:omit` y exige HTTP exitoso + al menos un bundle `/assets/`. Cachea todos los bundles con credenciales omitidas **antes** de publicar `/` en la nueva caché. Si uno falla, la promesa de instalación rechaza y no ejecuta `skipWaiting`.
- `activate` exige que el HTML y **todos sus bundles referenciados** estén presentes en la nueva caché; sólo después limpia los `sedeagro-web-shell-*` anteriores y reclama clientes.
- La navegación `/` en línea continúa siendo **network-first**, sin volver a guardar HTML. Si falla la red, usa el último snapshot completo de su versión; un nuevo despliegue sólo modifica el snapshot cuando se instala un **nuevo SW** verificado.
- `/api/`, rutas de otro origen, escrituras HTTP y cualquier petición con `Authorization` quedan fuera. No se agregan tokens, API, fotos ni evidencias al almacenamiento del SW. Los `/assets/` públicos siguen cacheándose por nombre de contenido, sin mezclar evidencias privadas.
- No se modifica sesión, JWT, PostgreSQL, RLS, IndexedDB de observaciones, migrations ni despliegue. No es una garantía contra una eliminación de todos los datos de sitio por el navegador.

## Verificación y criterios de cierre

1. `npm --workspace frontend run test`: prueba unitaria con ejecución del código real del SW en VM, cache fake y respuestas HTTP controladas, cubriendo instalación completa, navegación de release v2/v3, vuelta offline, 503/404, HTML 200 sin bundles, activación con un asset faltante y exclusión de API/Authorization.
2. `node frontend/test/offlineBrowser.mjs` (CI Chromium real): instalación de la app React compilada de producción, CacheStorage v3 y reapertura offline. Requiere runner con Playwright y browser instalado.
3. Revisión humana pendiente: despliegue autorizado en staging HTTPS, version skew durante actualización, Android Chrome, Safari iOS, cierre completo, cambio de red, eviction/quota, y navegación bajo cookie HttpOnly. Documentar evidencia con hora y navegador, sin fotografías o datos privados.

**GO/NO-GO:** este control reduce el riesgo de un shell corrupto y permite verificar una parte del cold-start. No autoriza despliegue, no cierra #163 ni #232, y no cambia la decisión NO-GO del release #130.
