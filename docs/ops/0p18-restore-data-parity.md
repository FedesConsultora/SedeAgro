# 0P.18 — Paridad de datos y secuencias después de `pg_restore` (CI aislado)

## Brecha real
0P.3/0T.4 ya ejecutaban un backup custom, `pg_restore` sobre `sedeagro_restore_test`, comprobación de migraciones, catálogos, tablas FORCE RLS y la suite real de API/RLS. Sin embargo, contar planes, cultivos y migraciones no detectaba cambios de valores dentro de filas ni secuencias de IDs mal restauradas.

## Corrección
- Se incorpora `scripts/sql/restore-data-fingerprint.sql`, ejecutado **solo en GitHub Actions sobre las bases desechables fijas** `sedeagro_test` y `sedeagro_restore_test`. Rechaza cualquier otra base y cualquier rol sin privilegio de superusuario de bootstrap de CI: FORCE RLS no puede ocultar filas al tomar la huella.
- La huella recorre tablas de aplicación del esquema `public`, excluye tablas propiedad de extensiones PostGIS y particiones hijas (se leen a través de su padre), calcula un digest de **cada fila** y agrega esos digests ordenados, preservando duplicados. Compara también estado `last_value/is_called` de secuencias PostgreSQL. Calcula finalmente un único digest de relaciones + conteos + contenido + secuencias.
- La salida contiene solamente `cantidad_tablas|cantidad_secuencias|digest`, sin imprimir registros, IDs, observaciones ni evidencias.
- En `scripts/ci-disposable-restore.sh` el resultado se obtiene antes del dump y después del restore real, se verifica sintaxis y presencia mínima de tablas, y **cualquier diferencia bloquea** el resto del rehearsal. Se conservan las comprobaciones previas de migraciones, catálogos, FORCE RLS, aprovisionamiento del runtime y tests de aislamiento sobre la base restaurada.
- `scripts/test/disposable-restore-guards.test.mjs` agrega regresiones sintéticas que exigen ejecución a ambos lados, comparación real y restricciones de alcance. La ejecución **real** SQL/PostGIS corre en el job `tenant-rls` existente; ningún mock acredita por sí solo el resultado.

## Invariantes y límites
1. Los hashes MD5 son para **comparación determinista de integridad dentro del ensayo CI**, no firmas, cifrado ni prueba de autenticidad ante adversarios. La evidencia se obtiene en la misma instancia/versión PostgreSQL, no verifica portabilidad entre versiones o collations.
2. El archivo crea solo una tabla **temporal de sesión** para sumar digests; no escribe en tablas de aplicación, ni se conecta a staging/producción. El runner padre no permite URLs ni nombres de base arbitrarios. Su cleanup destruye la base restaurada desechable y el archivo temporal.
3. El hash cubre valores de tablas de aplicación `public` y secuencias. La prueba anterior y los tests sobre DB restaurada complementan, pero esto **no** es verificación completa de cada definición de índice, ACL, extensión, integración externa o almacenamiento de evidencias fuera de PostgreSQL.
4. Si aparece una divergencia de contenido en CI, se bloquea la aceptación; la salida nunca expone registros afectados. Investigar sobre datos sintéticos y volver a correr sobre SHA exacto.
5. Staging real con HTTPS/roles, backup privado fuera del VPS, restore en instancia separada con datos de cliente, rollback compatible con escrituras posteriores al backup, Android/iOS físicos y aprobación GO/NO-GO de #130 siguen pendientes. **Sin intervención de producción desde este bloque.**

## Aceptación
- `bash -n scripts/ci-disposable-restore.sh`.
- `node --test scripts/test/disposable-restore-guards.test.mjs`.
- GitHub Actions: cuatro jobs verdes sobre HEAD exacto; en `tenant-rls`, backup y restore PostgreSQL/PostGIS descartables deben aprobar la nueva igualdad de contenidos y secuencias.
- Tras merge normal, repetir CI independiente sobre nuevo `main`. No inferir resultado de un SHA anterior.

## Gate de seguridad adicional descubierto durante el PR

La primera ejecución de CI para 0P.18 reveló un **nuevo advisory HIGH** en el frontend build, asociado a `vite@8.0.16` y la cadena `launch-editor` (manipulación de argumentos de CLI/Windows), mientras el backend siguió en 0 critical/high/moderate. El gate `dependency-security` bloqueó correctamente la corrida aunque los otros tres jobs aprobaron, incluido el restore real con la nueva huella.

En el mismo PR se incorporó una remediación compatible y separada en commits de seguridad: `vite@8.3.4` con lockfiles independientes frontend y raíz coherentes, usando las versiones/integridades SHA512 sugeridas por el `npm audit fix --package-lock-only` de diagnóstico en CI. No se usó `--force`, waivers ni supresión de CVEs. Los checks deben volver a pasar sobre el HEAD **posterior** a estos commits, no reutilizar el verde de restauración de la corrida anterior. Si una nueva auditoría reporta un HIGH, la integración queda bloqueada.
