# 0U — Puerta E2E del recorrido agrícola completo en CI PostGIS

## Qué prueba
`backend/test/pilotCriticalPath.pg.mjs` incorpora **una sola prueba integradora** a `npm --workspace backend run test:db`, ya ejecutado por el job `tenant-rls` de GitHub Actions. No agrega workflows ni ejecuta nuevas pruebas redundantes por módulo. Conecta **las mismas entidades y UUID** de un tenant A en una operación real HTTP/Express y PostgreSQL/PostGIS:
1. Empresa A y B, usuarios tenant_admin, scout, contractor con membresías activas y grants de módulos; establecimiento, lote y campaña asociados.
2. Coordinación programa una recorrida real del lote; la cuenta scout puede verla y otro tenant recibe 404.
3. Scout envía batch de observación con GPS WGS84 y clave de idempotencia; el mismo POST devuelve replay 200 y no duplica observación.
4. Scout envía fotografía privada con `client_upload_id`, verifica replay sin duplicación, contenido privado y denegación cross-tenant.
5. Coordinación crea una orden del **mismo lote y campaña**, asigna contratista y la aprueba; el contratista ejecuta, coordinación revisa con checklist independiente y cierra; cierre sin revisión rechaza 409.
6. Los tres endpoints CSV/PDF/XLSX de lote real deben incluir exactamente una observación y una orden; sin leakage de cross-tenant ni reportes para scout.
7. El propietario SQL confirma conteos, mismo `field_id`, estado verificado y GPS; una sesión de DB **no-owner sin BYPASSRLS** consulta el ID bajo dos valores transaccionales de `app.current_tenant`: tenant A 1 y tenant B 0.

## Aislamiento y seguridad
- Corre exclusivamente con `TEST_DATABASE_ADMIN_URL` y `TEST_DATABASE_APP_URL` de una base `*_test` que comparten nombre. Comprueba `rolsuper=false`, `rolbypassrls=false` y rol de aplicación distinto al propietario de la base.
- Entidades sintéticas con sufijo aleatorio y limpieza de tenants/users al finalizar; todos los endpoints usan loopback, nunca DNS/staging/VPS.
- No imprime tokens, coordenadas de usuarios, archivos privados ni notas reales; los datos son sintéticos.
- No realiza migraciones, cambia esquema, contratos backend, políticas RLS, imágenes ni despliegues.

## Evidencia y límites
La prueba verifica **integración del backend** que antes se comprobaba en tests distintos, no ejecución visual de frontend ni almacenamiento cifrado IndexedDB. La llamada `POST /sync/batches` ejecuta el mismo backend que usa la cola web, pero no demuestra modo avión, cierre de pestaña, reintentos del navegador o Safari. **MOB-05 #163 sigue abierto**, sin atajo de autenticación local. La orden comparte lote/campaña con la observación: **no existe una FK de orden a observación** y esta prueba no inventa esa trazabilidad.

La salida esperada es PASS/FAIL real del job `tenant-rls` sobre el **SHA final del PR** y, una vez fusionado, la corrida independiente push/main. Hasta que eso ocurra: `CI=NOT_RUN` o `CI=IN_PROGRESS` según GitHub. Staging, Android/iOS físico, seguridad Trivy y operadores firmantes de #130 siguen fuera de alcance y **NO-GO**.

Referencias: issue [#166](https://github.com/FedesConsultora/SedeAgro/issues/166), coordinación [#18](https://github.com/FedesConsultora/SedeAgro/issues/18), release [#130](https://github.com/FedesConsultora/SedeAgro/issues/130).
