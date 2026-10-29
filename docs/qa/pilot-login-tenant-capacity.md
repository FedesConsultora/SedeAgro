# SedeAgro 0.1 — Acceso directo a empresa cuando el catálogo supera el límite (#232)

**Problema operativo:** la defensa de `POST /auth/login` introducida por el FORCE RLS de `memberships` tiene un catálogo máximo de **250 empresas candidatas** para el descubrimiento sin selector. Superado el límite, aun con email y contraseña válidos, devuelve HTTP `503 LOGIN_DISCOVERY_CAPACITY_LIMIT`. El backend ya admite `tenantSlug` exacto y acotado (una empresa); la UI no permitía ingresarlo y podía dejar sin acceso a miembros autorizados. El botón «Volver» de la selección multiempresa anterior sólo escondía los botones, sin reiniciar la compuerta de intento.

## Implementación

- Se añade a login el control opcional **«Ingresar con identificador de empresa»**. El usuario informa el *slug* registrado, nunca ID de usuario, empresa ajena ni contraseña por URL. Valor: 3–90 caracteres, letras ASCII, dígitos o guiones (igual que el registro), normalizado sólo para entrada humana. No se guarda en `localStorage`, `sessionStorage`, URL, cookies ni logs. Se envía únicamente dentro del JSON de la solicitud HTTPS de login.
- La compuerta `createLoginAttemptGate` hace un único intento inmutable con el mismo par email/contraseña y el slug opcional; ninguna respuesta tardía puede autenticar otra cuenta tras cambiar de formulario. Si hay `tenantSlug` explícito, `verifyLoginSession` exige que **el slug devuelto por el servidor coincida exactamente** y rechaza un desafío de opciones en lugar de interpretar una selección inconsistente. No se infiere autorización a partir del nombre/slug escrito.
- Ante **503 exacto con código `LOGIN_DISCOVERY_CAPACITY_LIMIT`** después de intento *sin* slug, se despliega el campo, se **limpia la contraseña**, y la interfaz pide el identificador real de la empresa y nueva contraseña. La respuesta no se interpreta como credenciales inválidas, no se reintenta automáticamente la búsqueda masiva y no se muestra ninguna lista parcial de empresas.
- «Volver» desde la lista de empresas ahora ejecuta `handleBack`, retirando credenciales y opción pendiente de la compuerta antes de volver al formulario. No se alteran el inicio de sesión con cookie HttpOnly, la protección CSRF, la tasa máxima del endpoint, la expiración JTI, el permiso de empresa ni las consultas `Membership.findOne` con GUC por tenant.

## Pruebas

1. Pruebas unitarias de la compuerta: respuesta de slug diferente no puede autenticar; desafío de opciones con selector explícito se rechaza; intento antiguo no resucita tras error o «Volver»; formato de slug y entradas no textuales se rechazan; un intento dirigido nuevo conserva sólo las credenciales en memoria.
2. PostgreSQL real no-owner: `membershipForceRls.pg.mjs` se amplía con **251 empresas de prueba** creadas por el owner en una base *descartable* para forzar el límite. Comprueba selectorless **503 sin listado parcial**, slug real **200** con rol/empresa correctos, miembro bloqueado **403**, slug de empresa sin membresía **403**, credencial inválida **401**, y selección de otra empresa autorizada **200**, manteniendo `memberships` bajo ENABLE + FORCE RLS.
3. La cadena de primera empresa/scout/contratista/reporte sigue protegida por su prueba PostGIS independiente; no se generan accesos ni sesiones con `signSession` en la nueva prueba.
4. Sólo se da por integrado si CI exact-head PR **5/5** y CI independiente de `main` **7/7** concluyen `SUCCESS`.

## Fuera de alcance y riesgos

No se modifica el tope de 250, no se agrega consulta global privilegiada, no se evaden FORCE RLS ni se introduce el backend O(1) como reemplazo del control existente. El catálogo sin selector sigue costando hasta 250 búsquedas; la medición p50/p95 con 1/25/100/250 empresas, revisión por Security Owner y staging aislado siguen pendientes en #232. El *slug* es dato no secreto que sirve para reducir candidatos, **no** otorga acceso. Esta mejora facilita el camino disponible cuando hay muchas empresas, pero no certifica lanzamiento productivo. **Sin staging, sin dispositivos físicos y release #130 NO-GO**.
