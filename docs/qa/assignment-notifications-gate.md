# Gate 0S.2 — avisos transaccionales de asignación

Issue: #26. Este gate es **obligatorio antes de fusionar** la PR que cambia las escrituras de asignación. Pasar pruebas JS aisladas NO certifica que se preserva RLS ni que las transacciones funcionan.

## Preparación

Usar **exclusivamente PostgreSQL/PostGIS desechable**, con nombre que contenga el segmento `test`, migraciones y semillas actuales. No usar producción, staging compartido ni una base de datos con información de clientes. Configurar:

- `TEST_DATABASE_ADMIN_URL`: propietario de la base desechable, sólo para crear y limpiar fixtures.
- `TEST_DATABASE_APP_URL`: usuario de ejecución no propietario, sin SUPERUSER ni BYPASSRLS, para peticiones HTTP.
- Misma base migrada en ambas URLs. No pegar secretos en logs, comentarios ni PRs.

Desde `backend/`:

```bash
npm ci
npm test
TEST_DATABASE_ADMIN_URL='postgres://...' TEST_DATABASE_APP_URL='postgres://...' \
  node --test test/assignmentNotifications.pg.mjs
```

El test se niega a operar si el nombre de la base no incluye `test`. Al terminar limpia los usuarios y empresas creados. Si falla, comprobar que la limpieza final ocurrió antes de reutilizar la DB desechable.

## Evidencia mínima requerida

1. Asignación inicial de recorrida, PATCH idéntico, reasignación y desasignación sin duplicados.
2. Orden: asignación inicial 201, replay igual 200, conflicto 409, tres solicitudes concurrentes con una sola notificación.
3. Destinatarios activos en empresa correspondiente; usuarios bloqueados y roles sin lectura rechazados.
4. GET/PATCH notificaciones aislados por tenant y destinatario; el enlace a la entidad mantiene las autorizaciones propias del dominio.
5. Texto de aviso fijo sin instrucciones, datos de productores ni notas sensibles.
6. Rollback de relación y aviso cuando la transacción falla, sin mensajes huérfanos.
7. Evidencia de versión/fecha de la ejecución, commit HEAD exacto, DB desechable y resultado del comando; sin volcar contraseñas.

## Alcance explícito

La creación de una nueva recorrida mediante POST sin clave de idempotencia sigue siendo una operación **no idempotente**: repetir esa creación puede producir dos recorridas y, legítimamente, dos avisos. El comportamiento idempotente garantizado en este bloque es el PATCH sin cambio de asignado y la repetición de una asignación de orden con mismo usuario y responsabilidad. No se agrega soporte de `Idempotency-Key` para crear recorridas ni se modifica esquema/índices.

La entrega no incluye push, email, SMS ni tareas recurrentes; sólo avisos dentro de la bandeja autenticada. No desplegar ni presentar este bloque como listo para piloto si el gate PostgreSQL está pendiente.
