# 0R.32 — Verificación de volúmenes locales en staging OCI firmado

**11/11/2026 · Release #130: NO-GO.**

## Problema real

El inspector de staging comprobaba en `container inspect` que db y Redis montaban exactamente un volumen con el nombre de Compose. Esa comprobación no inspeccionaba de manera independiente los objetos Docker `volume`: un nombre coincidente no descarta un driver externo, una opción de montaje remoto o un volumen ajeno al proyecto con metadata equivocada.

## Defensa de solo lectura

En el modo **OCI firmado**, una vez verificados los cuatro contenedores y su censo completo, el inspector consulta únicamente los dos nombres fijados en el repositorio:

```text
docker volume inspect --format '{{json .}}' sedeagro-staging_staging_pgdata
docker volume inspect --format '{{json .}}' sedeagro-staging_staging_redisdata
```

Exige, para cada volumen:

- `Name` exactamente esperado, `Driver=local` y `Scope=local`, sin opciones de driver de NFS/bind/dispositivo.
- Etiquetas `com.docker.compose.project=sedeagro-staging` y `com.docker.compose.volume=staging_pgdata|staging_redisdata` correctas.
- `Mountpoint` absoluto, sin segmentos relativos, y con estructura Docker `.../volumes/<nombre>/_data`; admite prefijos distintos en Docker rootful/rootless.
- El montaje declarado por el **contenedor** debe coincidir con el `Mountpoint` inspeccionado, usar driver `local`, ser `RW` y estar en `/var/lib/postgresql/data` o `/data`, sin propagación especial.
- Ningún campo de entorno, ruta privada o contenido del volumen aparece en el resultado.

La bandera `project_volume_inventory_verified:true` sólo se emite cuando ambas comprobaciones pasan. `review-signed-staging-runtime.mjs` exige la bandera en **ambas** rondas de inspección de las imágenes y contenedores, de forma que una inspección omitida no pueda aprobar una revisión OCI firmada. El modo legacy conserva su comportamiento anterior.

## Validación

```bash
node --check scripts/verify-staging-runtime.mjs
node --test scripts/test/staging-runtime.test.mjs scripts/test/review-signed-staging-runtime.test.mjs
```

Las pruebas adversariales alteran nombre, driver, scope, opciones, etiquetas, ruta, fuente, destino, modo de lectura/escritura y tipo de montaje. Ninguna prueba toca volúmenes reales; la suite existente se ejecuta dentro del job `tenant-rls` de GitHub Actions.

## Límites

Un `docker volume inspect` correcto **no demuestra** que el host físico sea confiable, que los paths no contengan symlinks de sistema de archivos ni que un backup externo sea restaurable. No certifica aislamiento físico entre hosts, persistencia, cifrado, restauración off-VPS ni seguridad del daemon Docker. El inspector es de solo lectura: nunca inicia, modifica, elimina, monta ni copia datos de los volúmenes.

También siguen pendientes la firma real del Security Owner, staging privado HTTPS operativo autorizado, restauración y rollback independientes, QA física Android/iOS, los seis actores del piloto y las aprobaciones finales de Seguridad, Operaciones, Datos y Producto.

**Decisión actual: NO-GO para producción.**
