# 0P.8 — Auditoría de dependencias del candidato productivo

## Motivo

Los builds reales de la API en el CI 0P.7 registraron 12 vulnerabilidades en `npm ci --omit=dev` del backend (**11 moderadas, 1 crítica**) y el build del frontend registró **4 de severidad alta** en sus dependencias de compilación. El resultado `SUCCESS` anterior acreditaba funcionalidad/aislamiento, no una evaluación de seguridad de la cadena npm.

## Gate implementado

El nuevo job `dependency-security` en `.github/workflows/postgres-isolation.yml` ejecuta exactamente, sobre el SHA del evento y lockfiles de cada servicio:

```bash
(cd backend && npm audit --omit=dev --json) > backend-audit.json
(cd frontend && npm audit --json) > frontend-audit.json
node scripts/security-audit-report.mjs backend-audit.json frontend-audit.json
```

En CI los comandos `npm audit` pueden salir con código 1 por vulnerabilidades, por eso el workflow ejecuta igualmente el analizador. El script exige JSON de auditoría completo; un reporte inválido, red caída o respuesta sin conteos **bloquea**. Solo muestra nombres públicos de paquetes, títulos de advisories sanitizados y estado de corrección; no imprime tokens, registros privados ni headers del registry.

**Política inicial:** bloquear cualquier aviso `high` o `critical` en dependencias runtime de backend y en dependencias del build frontend. Los avisos moderados quedan inventariados para una segunda revisión, sin presumir que sean inocuos. Solo los tests de 0P.8 y el CI real permiten declarar un gate válido.

## Siguiente paso obligatorio para obtener verde

Inspeccionar la salida de `dependency-security`, resolver paquetes vulnerables con parches compatibles, regenerar `package-lock.json` de los servicios afectados conservando todos los binarios nativos opcionales en cada plataforma, y repetir **los cuatro jobs** (incluidos Docker productivo, PostGIS real y Chromium). No ejecutar `npm audit fix --force` a ciegas ni reemplazar un aviso sin prueba por una excepción temporal.

## Restricciones

- El estado aquí es **diagnóstico técnico**, no acreditación de ausencia absoluta de CVEs.
- `npm audit` depende del registro npm y sus advisories vigentes al momento de CI; una respuesta cacheada o una consulta fallida nunca autoriza el release.
- Las imágenes todavía utilizan tags base mutables, y la aceptación de seguridad operativa, staging, restores, QA de campo y go/no-go real siguen pendientes.
- No se accede a secretos de despliegue ni se cambia un VPS.
