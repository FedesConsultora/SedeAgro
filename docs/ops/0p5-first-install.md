# 0P.5 — Primera instalación controlada, sin debilitar los backups de actualizaciones

## Problema

El gate 0P.3 obliga correctamente a verificar una copia restaurada **antes de migrar una base existente**. Sin embargo, en la **primera instalación** la base PostGIS todavía no tiene las tablas de SedeAgro, por lo que no puede existir un backup con `tenants`, `fields`, `auth_sessions` y demás objetos exigidos por la vía de actualización.

0P.5 habilita una única alternativa deliberada. **No relaja el requisito de backup para ninguna base con tablas de usuario**, ni realiza instalaciones, migraciones o escrituras desde su propio validador.

## Dos vías mutuamente excluyentes

| Situación | Evidencia requerida antes de migrar |
| --- | --- |
| Primera instalación con PostgreSQL/PostGIS inmaculado | `SEDEAGRO_INITIAL_BOOTSTRAP_APPROVAL=FIRST_DEPLOY:<SHA40>` + `scripts/verify-fresh-install-db.sh` PASS consultando la base real |
| Actualización / base existente / migración incompleta / tablas no reconocidas | Respaldo previo privado, digest válido, `pg_restore --list` y restauración comprobada por operador según `docs/ops/0p3-backup-cutover.md` |

**Nunca combinar ambas:** si hay `SEDEAGRO_INITIAL_BOOTSTRAP_APPROVAL` y cualquiera de las variables de respaldo `SEDEAGRO_VERIFIED_BACKUP_FILE`, `SEDEAGRO_VERIFIED_BACKUP_SHA256` o `SEDEAGRO_RESTORE_APPROVAL`, se rechaza inmediatamente.

## Comprobación de base realmente nueva

`verify-fresh-install-db.sh` ejecuta únicamente un `SELECT` contra PostgreSQL desde el contenedor `db` con el rol propietario, usando la base identificada por `POSTGRES_DB`. Cuenta:

1. **Todas** las relaciones no pertenecientes a extensiones (`pg_class`, `pg_namespace`, `pg_depend`) en esquemas de usuario: tablas ordinarias/particionadas/foráneas, vistas y vistas materializadas, sin confundir `spatial_ref_sys` y otros objetos legítimos propiedad de PostGIS con datos del producto.
2. Esquemas personalizados no pertenecientes a extensiones, excepto `public`. La imagen real `postgis/postgis:16-3.4` crea también los esquemas vacíos `topology`, `tiger` y `tiger_data` como infraestructura: se aceptan **solamente cuando** figuran instaladas las extensiones `postgis_topology` y `postgis_tiger_geocoder` correspondientes. Las tablas ajenas a las extensiones dentro de esos esquemas **no** quedan exentas del conteo de relaciones. Cualquier otro esquema (incluido `app` de una migración incompleta) bloquea la instalación inicial.

Solo acepta la salida exacta `0|0`, sin salidas extra ni errores de consulta. Un problema al conectar, un rol ausente, cualquier objeto previo o un identificador de DB/rol inseguro dan **BLOCKED** antes de migrar. El comando no ejecuta creación, borrado, modificaciones ni backups.

La firma textual `FIRST_DEPLOY:<SHA>` expresa responsabilidad explícita, **no es una atestación criptográfica**, ni demuestra por sí misma que los volúmenes, el proxy, el dominio, el TLS o los controles de campo sean correctos.

## Ejemplo de procedimiento manual (NO ejecutado)

Después de la validación de staging y la autorización del responsable:

```bash
export SEDEAGRO_RELEASE_SHA="<SHA40_VALIDADO>"
export SEDEAGRO_DEPLOY_APPROVAL="DEPLOY:$SEDEAGRO_RELEASE_SHA"
export SEDEAGRO_INITIAL_BOOTSTRAP_APPROVAL="FIRST_DEPLOY:$SEDEAGRO_RELEASE_SHA"
unset SEDEAGRO_VERIFIED_BACKUP_FILE SEDEAGRO_VERIFIED_BACKUP_SHA256 SEDEAGRO_RESTORE_APPROVAL

# Comprobar en VPS que db/Redis son los contenedores correctos; hacer backup
# del estado previo de un servicio existente aunque éste parezca vacío.
# Con ventana de cambio aprobada, recién entonces:
# bash scripts/deploy-prod.sh
```

**Si ya existe cualquier dato operativo, aunque sea un tenant demo o un despliegue fallido previo, nunca usar la vía FIRST_DEPLOY**. Debe investigarse el esquema, preservar datos existentes y seguir el gate de backup/restauración.

## Pruebas y límites

- El SQL de lectura es un archivo único y revisable: `scripts/sql/first-install-footprint.sql`. Tanto el deploy como el CI ejecutan exactamente esta consulta, sin copiar variantes inconsistentes.
- Los tests unitarios `scripts/test/fresh-install-guards.test.mjs` simulan resultados SQL `0|0`, tablas previas, esquemas personalizados, SQL inválido y combinación de flags. No tocan DB/volúmenes reales.
- **CI ejecuta la consulta sobre una instancia real PostGIS descartable** antes de aplicar migraciones y exige `0|0`; después de migrar esa misma base exige una huella no nula. Esto prueba la distinción inicial/migrada sobre el esquema real de SedeAgro, **pero no certifica un VPS virgen ni una instalación de campo**.
- El gate 0P.1 sigue exigiendo SHA exacto, rama limpia, secrets y configuración; 0P.3 verifica `/health/ready` después del arranque.
- Esta mejora **no** equivale a código desplegado, QA físico en campo, pruebas reales de backup/restore de actualizaciones, certificado TLS, benchmark #105 ni accesibilidad #86.
