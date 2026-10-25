# P0 HTTP JSON inflation guard — mitigación acotada (#210)

**Base:** `main@6a5ade8dae88376aeee2e2f002d266d29afe29f4`. Sin migraciones, cambios de dependencias, locks, permisos ni producción. Release #130 **NO-GO**.

## Defecto en la cadena real

La API expone `express.json({ limit: '10mb' })` antes del enrutamiento y de la autenticación. Express 4 arrastra `body-parser@1.20.8`; la [alerta GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) describe un posible crash no autenticado al interpretar un frame comprimido con bytes sobrantes. La versión corregida `1.20.9` no está en los lockfiles actuales. La actualización oficial de la dependencia sigue obligatoria.

## Cambio funcional

La API web actual envía JSON sin `Content-Encoding`. Se configura `express.json({limit:'10mb',inflate:false})` antes de cualquier ruta pública o autenticada. El middleware de body-parser rechaza con **HTTP 415** los cuerpos JSON marcados como `gzip`, `deflate` o `br`, antes de descomprimirlos. Se conserva el límite actual de 10 MiB (las capturas offline pueden transportar fotografías en JSON base64). Las solicitudes JSON sin codificación no cambian, ni la comprobación de tenant, membresía y permisos.

Este cambio acota una superficie de ataque concreta, **no** sustituye actualizar el paquete vulnerable ni remedia el advisory separado de Zod. Si hay clientes externos que envían cuerpos JSON comprimidos deben migrar a JSON plano; no hay tal cliente en la implementación `frontend/src/services/api.js`.

## Evidencia y ejecución

`backend/test/jsonBodyEncoding.test.js` levanta `createApp()` real en un puerto efímero 127.0.0.1 y comprueba:
- gzip/deflate/Brotli con cuerpo application/json devuelven 415 antes del enrutamiento, y el proceso sigue vivo por `GET /health`;
- gzip seguido de bytes malformados retorna 415 sin efectuar descompresión;
- JSON sin Content-Encoding no recibe 415 y el límite original permanece 10mb;
- las respuestas no reflejan notas privadas, JWT, DSN ni variables de entorno.

**Limitaciones de evidencia:** el test de CI no equivale a una campaña de fuzzing ni valida producción, proxy o Nginx. El bloqueo **dependency-security HIGH permanece vigente** hasta actualizar realmente `body-parser` y resolver `zod` con un lock reproducible (véase #210). No marcar 4/4 PASS ni merge si el gate está rojo. No desactivar `npm audit` ni aceptar un resultado experimental sobre un SHA anterior.

**Rollback:** revertir `backend/src/app.js` y retirar el test/documento. Antes de permitir de nuevo cuerpos comprimidos exigir versión upstream corregida, tests de streams y aprobación de seguridad.

**Pendiente:** corregir con registry confiable y `npm ci` lockfiles `backend/package-lock.json`, `package-lock.json` raíz y dependencias aplicables; Zod 4.6.6 requiere pruebas completas de esquemas/422 y compatibilidad. No fabricar SHA de tarballs ni integridades.