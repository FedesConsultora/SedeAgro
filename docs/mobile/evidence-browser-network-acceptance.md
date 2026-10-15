# 0S.16 — Aceptación Chromium real del historial de evidencias con red intermitente y permisos revocados

## Por qué este bloque

Los bloques 0S.12–15 tienen tests de seguridad, PostGIS con 1.000 filas y validaciones estructurales del frontend. Faltaba verificar la interacción del **React montado en Chromium real**, bajo cookie **HttpOnly**, mientras cambia la red o la autorización entre solicitudes. No se reemplaza la API por mocks; el test usa Express + PostgreSQL/PostGIS y Vite reales, con interceptación de una URL modificada **hacia el propio backend** solo para provocar un 400 de cursor incorrecto.

## Test incorporado

`scripts/acceptance-browser-evidence-history.mjs` crea una empresa de prueba mediante el formulario real de React, inicia sesión por cookie, habilita módulos de prueba y genera una recorrida con una observación y **13 archivos de metadatos sin blob** en `sedeagro_test`. Toda escritura, incluso la revocación de una sesión, se limita a esta base descartable. El script impide explícitamente conectarse a una base que no contenga el sufijo `_test`; limpia la empresa/usuario después y mata procesos locales.

Una secuencia real de navegador ejecuta:
1. Inicio de sesión por formulario, Monitoreo, detalle autorizado, **10 archivos reales en página 1**. No se descargan bytes del backend.
2. Clic manual en **Verificar SHA-256** de un archivo, respuesta backend `missing` por ausencia de blob, **exactamente una** petición de integridad. Sin barridos automáticos.
3. **Página 2 (3 archivos) → página 1**, con estado previo de integridad eliminado al cambiar de página.
4. Modificación del cursor solicitado hacia `cursor=forged` con `route.continue`, rechazo **HTTP 400 real** del backend y retorno seguro a la primera página.
5. Desconexión real del contexto Chromium (`setOffline(true)`) y evento del navegador; el panel deja de presentar evidencia vigente. Reconexión, refresco desde página 1 en vez de reusar cursor previo.
6. Revocación del entitlement `scouting` en DB mientras la sesión sigue abierta; la siguiente consulta debe fallar (403), ocultar evidencias viejas y nunca presentar un historial vacío como éxito. Restauración en base de prueba.
7. Revocación de **auth_sessions** en DB mientras cookie HttpOnly sigue en el navegador. La siguiente consulta obtiene 401, la aplicación invalida la sesión y desmonta la vista privada, mostrando formulario de ingreso.

La prueba se ejecuta después de la aceptación existente de cookies en el job `tenant-rls` de `.github/workflows/postgres-isolation.yml`; usa Playwright 1.58.2 y Chromium, ya instalados en ese mismo job. No añade dependencias permanentes ni altera código backend/RLS o la ruta de sync.

## Interpretación de resultados

Los estados offline/online del navegador y los controles de la UI se comprueban como comportamiento de Chromium, **no equivalen** a una prueba en hardware iOS/Android, LTE rural o un corte físico de red. La modificación controlada de URL no prueba ataques complejos al cursor, ya cubiertos en unit/PG de 0S.14, sino la recuperación visual de un **400 real**. La revocación de módulo y cookie sí ocurre en PostgreSQL y es aplicada por Express en la siguiente solicitud.

En caso de fallo del nuevo job, **NO declarar CI verde ni fusionar**. Antes de liberar una versión para campo faltan piloto con dispositivos y red reales, monitoreo de latencias, análisis de ergonomía bajo pérdidas prolongadas, y aprobación operativa del despliegue. No hay cambios de migraciones, IndexedDB, archivos privados, GPS/GIS ni producción en este bloque.
