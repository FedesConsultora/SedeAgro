# Piloto SedeAgro 0.1 — expediente de aceptación móvil por SHA (0R.10)

**Coordinación:** #18 · **Release:** #130 sigue **NO-GO**. Este documento acompaña la matriz MOB-01..MOB-12 de `docs/pilot-field-acceptance-0l.md`.

## Propósito

La CI prueba Chromium/Linux, Express y PostgreSQL, pero no constata que un operador haya hecho realmente la toma de fotografías/GPS, la reapertura sin red y el reenvío en **Chrome Android y Safari iOS físicos**. Por eso un `7/7 SUCCESS` no debe convertirse en un GO móvil. El script nuevo valida exclusivamente que el **registro manual** de aceptación sea completo, trazable a un SHA exacto y no mezcle casos de distintos dispositivos.

No captura imágenes, no descarga datos, no toca staging, no autentica operadores y **no verifica la existencia ni autenticidad de evidencias externas**. Un PASS en el JSON sigue siendo una declaración que requiere revisión independiente y el expediente de evidencia privado correspondiente.

## Preparación sin escrituras de infraestructura

Generar una plantilla con 22 entradas `NOT_RUN`:
```bash
node scripts/validate-pilot-mobile-evidence.mjs --template \
  --sha <SHA40-EXACTO-DE-MAIN> --origin https://staging.ejemplo.com \
  > mobile-evidence.json
```

Completar únicamente los campos permitidos: `case_id`, `device`, `status`, `tested_at`, `device_profile`, `browser_version`, `evidence_ref`, `issue_ref`. El `evidence_ref` usa un identificador interno opaco `QA-...` del repositorio **privado** de evidencias; jamás incluir enlaces firmados, cookies, JWT, emails, capturas, coordenadas, fotos, nombre del operador ni contenidos de producción en este JSON. Guardar el archivo en un almacén privado autorizado, no en Git.

- `PASS`: fecha UTC ISO en los últimos 14 días, perfil anónimo del equipo (ej. Android 14 QA), versión del navegador, referencia interna opaca del respaldo. `issue_ref=null`.
- `FAIL`: mismos campos y `issue_ref=#123` al defecto abierto.
- `BLOCKED`: `issue_ref=#123` y todos los campos de ejecución/evidencia en `null`.
- `NOT_RUN`: todos los campos de ejecución/evidencia/issue en `null`.

MOB-01 exige Android Chrome; MOB-02 iOS Safari; MOB-03..12 en **ambos**. No se admite otra plataforma o un segundo resultado del mismo caso/dispositivo. La plantilla deja todo sin ejecutar, incluso si la CI está verde.

Validar contra el SHA **actual** de la versión entregada físicamente:
```bash
node scripts/validate-pilot-mobile-evidence.mjs \
  --file mobile-evidence.json --sha <SHA40-EXACTO-DE-STAGING>
```

La salida tiene `status` (`BLOCKED`, `INCOMPLETE` o `COMPLETE_FOR_HUMAN_REVIEW`), casos faltantes y cuatro contadores. **Siempre** devuelve `production_go:false`, `evidence_verified:false` y `device_verified:false`, incluso si alguien declara los 22 casos PASS. Código de salida 2: estructura inválida/identidad rechazada; 1: expediente incompleto o con fallos; 0: estructura completa que **sólo puede pasar a revisión humana**. Nunca sirve como firma de Security/Product/Ops.

## Dependencias de producción que este bloque NO cubre

- Staging autorizado con HTTPS, usuarios de seis actores, RLS y migraciones reales, integridad de imágenes OCI, restauración cifrada off-VPS y plan de rollback.
- QA física reproducible con prueba real de cámara/HEIC, GPS precise/approximate, cold-start sin red, cuota, revocación, idempotencia y cambio de tenant.
- Validación de incidentes abiertos, benchmark HTTP de #143 y decisiones externas de Seguridad, Producto, Operaciones y Datos conforme #130.

Las pruebas Node sólo verifican el **validador de metadatos**. Ninguna prueba crea una identidad física ficticia ni acredita un dispositivo real.
