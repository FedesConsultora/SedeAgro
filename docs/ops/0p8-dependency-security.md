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

## Parches aplicados en el PR

La auditoría inicial de un runner descartable identificó `proxy-addr 2.0.7` (crítico, IP spoofing con subredes de confianza IPv4 mapeadas a IPv6), y los avisos altos de `immutable 5.1.6`, `nanoid 3.3.12`, `postcss 8.5.15` y `source-map-js 1.2.1`.

Usando únicamente `npm audit fix --package-lock-only` en carpetas temporales **fuera del workspace raíz** se generaron cambios revisables, después aplicados a los lockfiles versionados en commits separados:

- Backend: `proxy-addr 2.0.8`, `express 4.22.3` y dependencias transitivas compatibles.
- Frontend: `immutable 5.1.9`, `nanoid 3.3.20`, `postcss 8.5.31` y `source-map-js 1.2.2`, preservando los binding binarios opcionales de Rolldown/LightningCSS/Parcel.

En el workflow preliminar del SHA `d52da55db60035c7427b1beaf02422c5b78c0721`, el job de seguridad indicó **0 críticos y 0 altos** en ambos ámbitos; backend retuvo **6 moderados**, frontend **0 moderados**. Estos resultados deben revalidarse en el SHA final premerge y posmerge. Los moderados quedan visibles por paquete/título para evaluación posterior; no se afirma ausencia total de vulnerabilidades.

No se realizó actualización forzada de majors ni se degradó el criterio fail-closed. El gate seguirá rechazando avisos altos/críticos futuros.

## Siguiente paso obligatorio para un GO

Completar los cuatro jobs del SHA exacto (incluyendo Docker productivo, PostgreSQL/PostGIS + restauración, Chromium y auditoría de seguridad), revisar los seis avisos moderados con sus rutas de explotación y decidir formalmente aceptarlos o remediarlos. Ninguna prueba automatizada sustituye staging real, backup y restauración real, QA de campo o firma de release.

## Restricciones

- El estado aquí es **diagnóstico técnico**, no acreditación de ausencia absoluta de CVEs.
- `npm audit` depende del registro npm y sus advisories vigentes al momento de CI; una respuesta cacheada o una consulta fallida nunca autoriza el release.
- Las imágenes todavía utilizan tags base mutables, y la aceptación de seguridad operativa, staging, restores, QA de campo y go/no-go real siguen pendientes.
- No se accede a secretos de despliegue ni se cambia un VPS.
