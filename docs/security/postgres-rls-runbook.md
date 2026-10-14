# Bloque 0C — PostgreSQL RLS y separación de roles

## Riesgo corregido

El rol de base utilizado por el backend no puede ser el usuario `POSTGRES_USER` del contenedor Postgres: ese usuario suele ser superusuario y puede eludir las políticas `ROW LEVEL SECURITY`, incluso si están marcadas `FORCE`.

Desde este bloque:

- El backend de producción utiliza `APP_DB_USER` y `APP_DB_PASSWORD`, separados del propietario de los objetos.
- `connectDb()` **no permite arrancar en producción** con una cuenta propietaria de la base ni un rol con `SUPERUSER`, `BYPASSRLS`, `CREATEDB` o `CREATEROLE`.
- La inicialización del contexto usa `SELECT set_config('app.current_tenant', :tenantId, true)` dentro de una transacción, con UUID validado.
- Se habilita `FORCE ROW LEVEL SECURITY` sobre `tenant_integrations` (credenciales de integraciones) y `tenant_seat_usage`.
- El servidor revierte la transacción ante desconexión y gestiona errores al inicializar la conexión.

## Preparación obligatoria del VPS

No ejecutar el script de despliegue inmediatamente sin comprobar la base y realizar una copia de seguridad.

1. Confirmar el nombre real del volumen PostgreSQL y obtener un backup consistente antes de cambiar credenciales o aplicar migraciones.
2. Mantener `POSTGRES_USER` / `POSTGRES_PASSWORD` como propietario del esquema y configurar en el `.env` raíz:
   - `APP_DB_USER=sedeagro_app`
   - `APP_DB_PASSWORD=<clave aleatoria URL-safe de al menos 24 caracteres>`
3. Confirmar `NODE_ENV=production`, el secreto JWT y `SEED_MODE=prod` en `backend/.env`.
4. Ejecutar `./scripts/deploy-prod.sh` durante ventana controlada. El script construye imágenes, inicia la base, ejecuta las migraciones como propietario en un contenedor efímero, provisiona el rol no privilegiado y recién después reemplaza backend/frontend.
5. Verificar el backend y el resultado de `SELECT current_user` en una conexión con las credenciales de la aplicación. La conexión de servicio no debe tener atributos elevados.
6. Verificar login, lectura de lotes, creación de una observación y separación entre organizaciones. Si el gate falla, **no habilitar tráfico de clientes**.
7. Si la base de producción ya tenía usuarios demo del bloque 0A, seguir `docs/security/production-demo-audit.md`. La creación de un rol nuevo no revoca accesos de usuarios finales.

**Alcance operativo:** este PR modifica scripts, no ejecuta por sí mismo acciones sobre el VPS ni rota credenciales ya existentes. No imprimir los secretos. El script valida que la nueva contraseña sea URL-safe para la URL PostgreSQL de Compose.

## Gate real de PostgreSQL/PostGIS

GitHub Actions ejecuta `.github/workflows/postgres-isolation.yml` para cada PR y push a `main`. Levanta PostgreSQL 16 con PostGIS, aplica las migraciones, provisiona el rol restringido y ejecuta:

```bash
npm --workspace backend run test:db
```

Este test **requiere obligatoriamente** `TEST_DATABASE_ADMIN_URL` y `TEST_DATABASE_APP_URL`, apuntando ambas a una base **desechable** cuyo nombre incluya `test`. Si faltan las variables o la base no es de pruebas, el comando falla sin intentar modificar datos.

El test comprueba las 27 tablas RLS verificadas, separación de lecturas por tenant, no filtración de credenciales de `tenant_integrations`, protección de la clave compuesta `(tenant_id, farm_id)` al insertar un lote y limpieza del `SET LOCAL` al finalizar la transacción. Crea datos temporales con prefijo `rls-test-` y los elimina al terminar.

## Límites que requieren otro bloque

- `memberships` y `tenant_modules` son tablas de alcance de empresa todavía no cubiertas por RLS, porque el login multitenant y la administración global consultan registros de varios tenants. Requieren rediseñar el acceso privilegiado mediante procedimientos mínimos o servicios separados.
- La política protege en la base **por tenant**, no por lote. El seguimiento por campo, asesor externo y cliente productor necesita grants de recursos.
- En el middleware HTTP existente, algunas transacciones se cierran después de que el cuerpo de respuesta terminó de enviarse. Este diseño debe migrar a un patrón de commit-antes-de-responder para eliminar fallos de persistencia no informados.
- Las políticas existentes no sustituyen pruebas E2E completas de autorización, ni una auditoría de permisos de SQL fuera de los esquemas previstos.

La Beta con datos de productores no debe anunciarse como segura hasta completar estos controles y verificar el despliegue real.
