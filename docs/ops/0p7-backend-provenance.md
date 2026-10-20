# 0P.7 — Proveniencia de imágenes y versión real de la API

## Riesgo abordado

En 0P.3–0P.4 se comprobaban disponibilidad del backend y políticas de HTTPS. En 0T.3 se contrastaban bytes reales del frontend servido con el manifiesto de CI. **Todavía faltaba verificar que la API detrás del proxy ejecutaba el mismo commit de `main` autorizado**. Un VPS podía servir React actualizado contra una API anterior y seguir dando 200 en `/health/ready`.

## Contrato implementado

- Los Dockerfiles de `backend` y `frontend` exigen `ARG RELEASE_SHA` de **40 caracteres hexadecimales minúsculos**, y rechazan builds sin la referencia o con valores inválidos (fail-closed).
- Ambas imágenes finales incluyen la etiqueta OCI `org.opencontainers.image.revision=<SHA40>`. El backend también establece dentro de su imagen `SEDEAGRO_BUILD_SHA` en tiempo de build, para que la API pueda informar su revisión real sin consultar Git del host.
- `docker-compose.yml` recibe el argumento de compilación desde `SEDEAGRO_RELEASE_SHA` autorizado por el preflight de 0P.1. Nunca usa un SHA distinto por omisión. No se modifica el Compose de desarrollo.
- `GET /health/revision` es público, no contiene ningún secreto ni datos de tenants y devuelve `{"revision":"<SHA40>"}` con 200 y `Cache-Control: no-store`. Si falta el SHA o no es válido devuelve 503 y `{"revision":null}`. La revisión del backend pertenece a la imagen, no a un checkout local.
- `scripts/verify-pilot-staging.sh` ahora **lee directamente la respuesta de `https://STAGING/health/revision`** y exige igualdad exacta con el SHA completo aprobado; además de HTTPS, HSTS, readiness DB y autenticación anónima 401. No sigue redirecciones ni acepta JSON alternativo.
- CI `production-images` compila ambas imágenes con el SHA real del evento, verifica las etiquetas OCI vía `docker image inspect` y conserva sus smoke tests. Las suites HTTP y de staging (simulada sin red) prueban 200/503 y rechazo de una API vieja.

## Uso para el go/no-go

La comprobación externa de backend completa la comparación de los recursos estáticos del frontend, pero ambas tienen alcances distintos:

| Control | Qué demuestra | Qué todavía NO demuestra |
| --- | --- | --- |
| `/health/revision` vía HTTPS | SHA anunciado por la **imagen** backend que contestó | Que se utilizó exactamente la misma imagen binaria del CI |
| Etiquetas OCI del build CI | Ambas imágenes fueron construidas desde el SHA registrado | Que los digests OCI desplegados son iguales a los del CI |
| `verify-deployed-staging.mjs` | Archivos estáticos públicos coinciden con SHA/manifiesto del CI | Aislamiento RLS, resultados agronómicos o datos offline |
| `/health/ready` | Acceso runtime a PostgreSQL al momento de la prueba | Migraciones compatibles, no pérdida de datos ni presencia de worker |

El despliegue de 0P.3 sigue siendo **in-place, no blue/green**. Esta comprobación no realiza cambios de infraestructura, backups, migraciones ni DNS. La aceptación final requiere backup-restauración real de staging, dos tenants y permisos, sesiones/cookies con HTTPS, pruebas físicas Android/iOS, red rural, rendimiento #105, accesibilidad #86, rollback y autorización responsable antes de ejecutar `scripts/deploy-prod.sh`.

## Procedimiento seguro

Al operar un checkout del SHA aprobado, `SEDEAGRO_RELEASE_SHA` debe estar exportado desde el mismo proceso que llama a `docker compose build`; la ausencia bloquea la compilación. No pasar JWT, claves DB o secretos como `ARG` de Docker. Tras instalar staging, validar el backend desde un cliente externo mediante:

```bash
bash scripts/verify-pilot-staging.sh https://staging.example.com SHA40_APROBADO
```

Esto es una verificación de código candidato, **no una certificación de producción**.
