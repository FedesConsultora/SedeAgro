# 0P.38 — Exclusión host-wide de despliegues productivos (SIN GO)

## Brecha concreta

`scripts/deploy-prod.sh` no tenía exclusión de ejecuciones simultáneas:
dos operadores o dos clones podían intercalar `git pull`, verificaciones,
migraciones, provisión de roles y recreación de servicios. El candidato
OCI firmado del bloque 0P.37 demostró la identidad **únicamente en CI**
al crear contenedores detenidos; no probó el ciclo de vida operativo.

## Control añadido

El entrypoint productivo carga `production-deploy-lock.sh` **antes**
de leer los .env, ejecutar Git, preflight, Docker, backup o migraciones.

- Nombre fijo del host: `/run/lock/sedeagro/production-deploy.lock`.
  No depende de checkout, branch, worktree o variables de entorno.
- Requiere Linux `flock`, directorio privado del UID operador (0700)
  y archivo regular privado (0600), con un solo hardlink, no symlinks.
  Comprueba el mismo dispositivo+inode del descriptor abierto frente
  al pathname y usa `flock -n` (no espera indefinidamente).
- El descriptor permanece abierto por el proceso `deploy-prod.sh`,
  incluyendo preflight, migraciones y verificación de readiness.
  El helper restaura la máscara `umask` original del llamador tras
  crear de forma privada el lock: no modifica permisos posteriores
  de Git, archivos de diagnóstico ni procesos de Docker.
  El kernel libera el lock al terminar/morir la última referencia al
  descriptor. No borrar el archivo del lock: su unlink permitiría dos
  locks sobre inodos distintos.
- Directorio inaccesible, propietario distinto, permisos inseguros,
  symlink o lock ocupado => **fail-closed (exit 2)** antes de operaciones.
  Si el host ejecuta deploy con otro UID, requiere coordinación
  operativa del MISMO UID/namespace; no se recomienda cambiar
  permisos a 0777 para hacerlo funcionar.
- Un lock **no es aprobación**: preflight firmado de 0P.33 y la
  condición `release_go=false` siguen bloqueando producción. La
  reconstrucción local continúa bloqueada; el override OCI aún no está
  integrado a un procedimiento autorizado.

## Alcance de las pruebas

`node --test scripts/test/production-deploy-lock.test.mjs`:
exclusión real entre dos procesos Bash con cwd distintos,
liberación del lock tras terminar el holder, inode persistente,
directorio/archivo con permisos inseguros, symlink de namespace
y de archivo, hardlink y prohibición de ejecutar el helper
como una vía alternativa de deploy. Se valida el orden estático
del entrypoint y que el roster humano de Seguridad sigue vacío.
No se invoca `deploy-prod.sh` funcionalmente en estas pruebas;
no hay conexión a VPS ni se crean contenedores de aplicación.

## Riesgos y próximos pasos

Este lock cubre exclusivamente invocaciones que pasan por
`scripts/deploy-prod.sh` en **un mismo host Linux**.
No serializa ejecutores sobre múltiples hosts, `docker compose`
manual, ni comandos administrativos fuera del entrypoint.
El entorno deberá impedir privilegios y accesos Docker
que permitan saltar ese proceso. No reclamar protección
distribuida ni compatibilidad con despliegue Compose aún.

**#130 sigue NO-GO**: falta Security Owner enrolado y firma Ed25519
real de riesgos, recibos OCI exact SHA, selección por imagen inmutable
al crear contenedores reales, staging aislado HTTPS autorizado,
backup externo cifrado + restore/rollback real, aceptación física
Android/iOS offline y firmas Operations/Data/Product/Security.
No ejecutar deploy ni tocar infraestructura productiva por este PR.

Rollback del bloque: revertir el PR **solo tras revisión formal**; 
eliminar este control reduce seguridad frente a concurrencia. En caso
de lock residual, inspeccionar procesos y descriptores antes de actuar,
sin borrar el archivo compartido.
