# Auditoría de cuentas demo y despliegue seguro

**Ámbito:** SedeAgro, producción y staging. **No ejecutar SQL destructivo como parte del despliegue.**

## Protecciones implementadas

- `npm run seed` aplica solo seeders de catálogos globales por defecto.
- Las cuentas ficticias requieren `SEED_MODE=demo` y `DEMO_PASSWORD` con 12 o más caracteres en un ambiente no productivo.
- `NODE_ENV=production` impide seleccionar el seeder demo; el propio seeder rechaza su invocación directa en producción.
- Toda ruta privada exige JWT y membresía activa también durante desarrollo.
- La administración global exige `is_platform_admin === true`, nunca una identidad ausente.
- **Estas protecciones no eliminan las cuentas ya creadas.** Las credenciales previas deben revisarse en la base real.

## Auditoría de producción antes de habilitar un entorno público

1. Verificar `NODE_ENV=production`, `SEED_MODE=prod`, un JWT_SECRET aleatorio y exclusivo, y ausencia de DEMO_PASSWORD. No imprimir secretos.
2. Con respaldo reciente de PostgreSQL, ejecutar esta consulta de **solo lectura**:

```sql
SELECT t.slug AS tenant_slug, u.email, u.status AS user_status,
       u.is_platform_admin, m.status AS membership_status
FROM memberships m
JOIN users u ON u.id = m.user_id
JOIN tenants t ON t.id = m.tenant_id
WHERE t.slug = 'agro-demo' OR u.email LIKE '%@agro-demo.test'
ORDER BY t.slug, u.email;
```

3. Si aparecen cuentas de demo, confirmar que nadie real las esté usando y desactivar sus accesos, revocar permisos globales y sesiones mediante el procedimiento operativo correspondiente; **no borrar datos automáticamente**.
4. Comprobar que `GET /api/v1/auth/me` sin Authorization devuelve 401; con JWT inválido 401; con sesión válida del tenant correcto, 200.
5. Verificar que `GET /api/v1/platform/tenants` no esté disponible para usuarios sin el flag de administración global.
6. Revisar logs de acceso si hubo exposición pública de cuentas con claves conocidas. Planificar la rotación de secretos y la revocación de sesiones activas.
7. Antes de pilotos reales, ejecutar las pruebas de aislamiento RLS, integridad relacional y permisos de cada módulo con PostgreSQL.

## Limitaciones de este PR

No comprueba si la base del VPS contiene cuentas demo ni modifica los usuarios existentes. Tampoco agrega aún autorización granular a todas las operaciones de negocio ni ejecuta pruebas end-to-end en PostgreSQL. Son bloqueos de hardening posteriores.
