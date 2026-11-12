# 0R.47 — Expediente de aceptación por actor (0U / piloto 0.1)

**12/11/2026 · Release #130: NO-GO · Sin despliegue ni acceso a staging real.**

## Brecha que cierra

La integración de PostGIS descartable ya encadena HTTP real desde registro/invitación hasta GPS, JPEG privado, sincronización, orden, revisión independiente y reportes (backend/test/pilotActorOnboarding.pg.mjs). Para el piloto falta registrar esos resultados en un **staging autorizado**, con un SHA exacto, evidencias privadas y denegaciones por rol. El nuevo script scripts/validate-pilot-actor-evidence.mjs revisa un expediente **declarado por operador**. No se conecta a staging, no hace pedidos HTTP y nunca emite GO.

### Seis identidades, no seis roles diferentes

El ensayo HTTP usa cinco roles del tenant A y un admin externo B para la frontera de aislamiento. Las identidades son: admin A, coordinador A, scout A, contratista A, productor visualizador A y admin B. Esto no equivale a certificar el actor estratégico *asesor externo*, que requeriría definir su contrato de permisos.

## Matriz exacta de 15 casos

| Caso | Principal | HTTP esperado y evidencia a custodiar |
|---|---|---|
| ACT-01 | tenant-admin-a | 201 registro de empresa |
| ACT-02 | tenant-admin-a | 201 GIS y campaña del mismo lote |
| ACT-03 | tenant-admin-a | 200 reporte privado y revisado |
| ACT-04 | agronomic-coordinator-a | 200 revisión independiente |
| ACT-05 | scout-a | 201 observación GPS y JPEG privado |
| ACT-06 | scout-a | 200 replay del mismo lote offline sin duplicación |
| ACT-07 | scout-a | 401 cookie anterior tras revocación |
| ACT-08 | contractor-a | 201 ejecución asignada |
| ACT-09 | contractor-a | 403 prohibición de revisar su propio parte |
| ACT-10 | producer-viewer-a | 200 lote expresamente concedido |
| ACT-11 | producer-viewer-a | 403 campaña interna denegada |
| ACT-12 | producer-viewer-a | 200 lista SIN lote después de revocar permiso |
| ACT-13 | tenant-admin-b | 404 lote ajeno |
| ACT-14 | tenant-admin-b | 404 foto privada ajena |
| ACT-15 | tenant-admin-b | 404 reporte privado ajeno |

**El HTTP 200 no prueba el contenido de una respuesta ni la ausencia de duplicación.** Cada evidencia opaca QA-... debe apuntar a un respaldo privado con request ID, roles y tenant anonimizados, huella/conteo de DB, respuesta redactada y revisor independiente. ACT-12 exige demostrar el lote revocado ausente, no solo un HTTP 200.

## Contrato del expediente

Raíz exacta: schema, release_sha, staging_origin, journey_ref, cases.

- schema: sedeagro-pilot-actor-evidence-v1
- release_sha: SHA40 exacto, no nombre de rama
- staging_origin: origen HTTPS sin ruta, query, credenciales, localhost ni IP
- journey_ref: identificador opaco QA-JOURNEY-... común al expediente
- cases: hasta 15 resultados, claves exactas case_id, actor, status, http_status, tested_at, evidence_ref, issue_ref

Un PASS exige HTTP exacto, timestamp UTC canónico de los últimos 14 días, evidencia opaca única y issue_ref null. FAIL exige HTTP observado, evidencia privada y issue_ref como #123. BLOCKED exige issue_ref sin fecha ni HTTP inventados. NOT_RUN no admite fecha, HTTP ni evidencia. Casos faltantes/NOT_RUN son INCOMPLETE; FAIL/BLOCKED son BLOCKED; 15 PASS declarados dan únicamente COMPLETE_FOR_HUMAN_REVIEW.

El procedimiento siguiente es **ilustrativo**, no se ejecutó:

~~~bash
umask 077
mkdir -p /ruta/privada/qa-actor
chmod 700 /ruta/privada/qa-actor
node scripts/validate-pilot-actor-evidence.mjs \
  --template --sha SHA40_EXACTO --origin https://staging.ejemplo.test \
  --journey QA-JOURNEY-PILOT-20261112 \
  > /ruta/privada/qa-actor/actors.json
chmod 600 /ruta/privada/qa-actor/actors.json

# Solo después de completar pruebas reales autorizadas y custodiar evidencia:
node scripts/validate-pilot-actor-evidence.mjs \
  --file /ruta/privada/qa-actor/actors.json --sha SHA40_EXACTO
~~~

La CLI reutiliza la lectura privada de 0R.46: archivo regular 0600 dentro de directorio 0700, del operador, ruta absoluta canónica sin symlinks, descriptor O_NOFOLLOW y tamaño máximo 64 KiB. No subir el JSON o evidencias reales a Git público. No introducir JWT, fotos, GPS, nombres ni emails como metadatos de este expediente.

Salida: código 2 para expediente inválido/inseguro; 1 para incompleto o bloqueado; 0 para registro declarado completo pendiente de revisión humana. Siempre staging_verified=false, evidence_verified=false, independent_review_required=true, production_go=false.

## CI y límites

~~~bash
node --check scripts/validate-pilot-actor-evidence.mjs
node --test scripts/test/pilot-actor-evidence.test.mjs
~~~

El job obligatorio tenant-rls incorpora el revisor al gate exact-head de PR y main. La integración HTTP/PostGIS original no se duplica ni modifica. Los tests nuevos son adversariales y validan formato, roles, códigos denegados, timestamps, duplicados, archivos privados y ausencia de GO.

**NOT_RUN fuera de CI:** staging HTTPS real, backup off-VPS/RTO/RPO, dispositivos Android/iOS físicos, revisión independiente de testigos y firmas humanas. El contenido del JSON puede falsificarse; el validador no autentica al operador ni verifica las referencias QA. La aceptación operativa exige logs originales, testigos protegidos, aislamiento real y cierre independiente de los bloqueos de #130.

**Decisión de producción: NO-GO.**
