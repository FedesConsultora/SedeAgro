# 0P.2 — Readiness de PostgreSQL para el corte de tráfico

SedeAgro diferenciaba la vida del proceso HTTP (`GET /health`, responde 200) de la disponibilidad real del backend. Con este bloque se agrega `GET /health/ready`: consulta la conexión **del rol runtime configurado** mediante `sequelize.authenticate()` y responde:

| Condición | HTTP | Cuerpo |
| --- | --- | --- |
| Conexión DB vigente | 200 | `{"ready":true}` |
| Conexión rota, timeout o error interno del probe | 503 | `{"ready":false}` |

En ambos casos `Cache-Control: no-store`. El endpoint **no expone** DSN, usuario, contraseñas, SQL, errores ni información privada por tenant; no necesita sesión. El backend ejecuta `connectDb()` al arrancar, que además verifica el rol no privilegiado en producción.

## Protección contra cascadas y falsos verdes

- Timeout de comprobación: **1.500 ms**. Una comprobación tardía no puede retrasar indefinidamente la respuesta al operador.
- Cache positivo/negativo de **2.000 ms**, que limita carga de monitoreo y nunca reutiliza una respuesta más allá del TTL.
- Múltiples peticiones comparten la misma promesa de respuesta. Si una llamada a PostgreSQL se queda pendiente más allá del timeout, se conserva como único upstream en curso hasta que se resuelva; las siguientes solicitudes siguen respondiendo 503 cuando agotan su timeout. No se generan consultas ilimitadas.
- Una respuesta exitosa fuera de plazo **no reescribe retroactivamente** el 503 ya servido.
- El liveness `/health` no cambia: 200 prueba el proceso, **no** DB, migraciones, RLS multiempresa o exact SHA.

## Evidencia automatizada

`npm --workspace backend run test` añade pruebas de coalescing, timeout, recuperación después del TTL, no reutilización de éxito obsoleto, errores del probe y servidor HTTP real en loopback. El CI previo y posterior al merge conserva PostGIS original + restaurado y Chromium.

## Uso seguro en staging, pendiente de realizar

Consultar `https://<staging>/health/ready` y exigir 200 **antes de admitir tráfico**, así como 503 al cortar de forma controlada la base de staging. Usar `curl -f` sin credenciales y revisar logs privados de la API solo cuando falle; nunca insertar contraseñas en comandos o tickets.

Este endpoint **todavía no realiza por sí mismo** un smoke de dos tenants ni verifica migraciones particulares, conectividad desde proxy TLS, backup/restore fuera de CI, ni el digest del backend desplegado. El siguiente bloque de orquestación debe utilizar readiness y no solamente liveness; **no se modifica el despliegue productivo en 0P.2**.
