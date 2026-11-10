# 0R.17 — respaldo previo al release: catálogo pg_restore exacto

**Fecha:** 10/11/2026 · Issue de coordinación #18 · Release #130: NO-GO.

## Hallazgo del código

`scripts/verify-production-backup.sh` ya bloqueaba migraciones sin SHA completo, consentimiento explícito `RESTORED:<release SHA>:<backup SHA256>`, archivo reciente privado off-repo, hash exacto y un `pg_restore --list` ejecutado por el contenedor PostGIS actual. Luego buscaba por `grep -qF` seis nombres de tablas. Eso aceptaba coincidencias en comentarios de TOC, entradas de datos que no son definiciones de tabla, prefijos como `work_orders_archive` o esquemas ajenos. Un listado imperfecto podía producir un falso OK, aunque **el operador continúa obligado a comprobar una restauración real** fuera del script.

## Cambio

El gate analiza exclusivamente filas TOC con forma:

```text
123; 1259 456 TABLE public work_orders owner
```

Es decir: identificador decimal terminado en punto y coma, dos OID decimales, tipo **`TABLE`**, esquema **`public`** y nombre exacto. Cada una de estas seis tablas debe aparecer **exactamente una vez**: `sequelize_migrations`, `tenants`, `auth_sessions`, `fields`, `work_orders`, `evidence_blobs`. Un `TABLE DATA`, comentario, vista, nombre prefijo, esquema `audit`, ID malformado o tabla duplicada bloquea el release sin exponer datos de respaldo ni modificar PostgreSQL.

Se utiliza `awk` del sistema, después de `pg_restore --list`, en modo **solo lectura**. Sigue sin poder probar el contenido de filas, conectividad del backup off-VPS, consistencia de relaciones o que el operador haya restaurado el archivo en un servidor aislado.

## Evidencia y recuperación

`node --test scripts/test/production-backup-guards.test.mjs` usa un archivo con hash sintético, permisos privados y un reemplazo simulado de Docker sin BD real. Incluye múltiples TOC hostiles además de las pruebas previas de archivo caducado, checksum, permisos, symlink, ruta de directorio, consentimiento y respuesta fallida de `pg_restore`. La CI debe ejecutar este test antes de cualquier afirmación de PASS.

Si no existe una definición exacta, detener el despliegue y corregir el procedimiento de respaldo, sin restaurar automáticamente en producción. Volver a generar y **verificar realmente** un respaldo externo aislado bajo supervisión de Operaciones/Datos. No se cambian secretos, permisos, migraciones, imágenes OCI ni servidores.

**La CI verde no equivale a respaldo restaurado real. Release #130 NO-GO hasta el ensayo humano de restore/rollback y demás firmas de aceptación.**
