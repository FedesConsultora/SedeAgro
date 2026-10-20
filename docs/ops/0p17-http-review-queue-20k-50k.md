# 0P.17 — HTTP de revisión real a 5k/20k/50k órdenes y concurrencia acotada

## Contexto
La remediación P0 de las seis alertas moderadas (PR #145 y #147) ya está integrada; #137 quedó cerrado tras el gate real. La intermitencia de foco modal #86 también quedó cerrada con PR #148. En #143 continúa el ensayo de escalabilidad: el PR #149 había probado 5000 órdenes del mismo tenant en API Express/Sequelize/PostGIS detrás de Vite y cookies HttpOnly de sesión Chromium real.

## Alcance implementado y prueba obligatoria
- Mantener la prueba real de **nueve filtros** del PR #149 a 5.000 órdenes, con 7 peticiones HTTP secuenciales por filtro, página de 50, HMAC siguiente página e IDs estables.
- Añadir **dos escalas sucesivas** de 20.000 y 50.000 órdenes, ampliando solamente los datos sintéticos existentes en la misma DB desechable. Cada incremento inserta órdenes de tipos, prioridades y vencimientos variados con partes `submitted`/`verified` mixtos. Validar el conteo exacto de nuevas órdenes y partes; no reinsertar duplicados.
- Para cada escala superior, medir cinco combinaciones representativas: `newest_all`, `blocked`, `human_review`, `due_overdue`, y filtro combinado `application + blocked + urgent + overdue + due_first`. Siete solicitudes reales por escenario: `p50/p95/p99` nearest rank del tiempo cliente local. Incluye segunda página con cursor firmado y verificación de que los 100 IDs pertenecen al tenant sintético y no se repiten.
- Añadir grupo de **tres GET simultáneas** a `blocked + newest` en 20.000 y 50.000: todas deben devolver 200, 50 IDs válidos, exactamente los mismos IDs ordenados y solo títulos sintéticos. Registrar p50/p95/p99 del grupo; no inventar throughput ni saturar con tráfico de larga duración.
- Mantener pruebas de adulteración y replay de HMAC entre ordenamientos (422), así como el inicio de sesión de **un segundo tenant** que no debe ver ningún registro de los 50.000 del primero.
- Garantías de ejecución: `CI=true`, `GITHUB_ACTIONS=true`, opt-in explícito, dos roles distintos sobre **la misma** DB PostgreSQL/PostGIS `*_test` en loopback. No configurar URL pública: el benchmark solo acepta `http://127.0.0.1:4177/api/v1/work-orders/review-queue`. No imprime cookies, UUID, cursores, SQL, secretos, notas privadas ni URLs de usuarios.
- CI exige gates exact SHA de `tenant-rls` (PostGIS, backup/restore descartable y Chromium), `browser-offline`, `production-images`, `dependency-security`. No ejecutar contra staging o VPS real, ni abrir migraciones nuevas.

## Interpretación y límites
Los tiempos observados son **HTTP localhost en GitHub Actions**, con hardware compartido, una cookie autenticada, fixture uniforme y un solo proceso Express. Siete muestras son suficientes para encontrar fallos y tendencias gruesas, **no** para definir un SLO ni percentiles estadísticos estables. El grupo concurrente de tres solicitudes prueba determinismo e integridad bajo una concurrencia limitada, no resiliencia de picos comerciales.

Una ejecución de 50k no prueba estabilidad de largo plazo, replicas, despliegue público TLS ni accesibilidad en dispositivos reales. El issue #143 debe permanecer abierto hasta que haya:
- mediciones de staging aislado con recursos equivalentes al host objetivo, límites operativos y presupuesto SLO explícito;
- carga concurrente realista y planes PostgreSQL de consultas que superen el umbral;
- detección/monitoreo de regresiones y procedimiento rollback;
- matriz release #130 con seguridad, backup/restore privado, Android/iOS, rural offline y aceptación humana completas.

La optimización SQL original no se modifica en este PR: el benchmark verifica el comportamiento productivo actual de manera reproducible.

## Evidencia real del primer run escalado

El [run premerge #39483684287](https://github.com/FedesConsultora/SedeAgro/actions/runs/39483684287) terminó **4/4 SUCCESS, intento 1**, HEAD `dfe05f92a048e4957a2a5dcddd602fdeafc399bd`. Entorno Linux x64, **4 CPUs lógicas**, ~15,6 GiB de RAM, Node 22.23.3, PostgreSQL/PostGIS 16.4 y 1 proceso Express en Chromium/Vite. Conteos insertados/acumulados: 5000/4000 partes, 20000/16000 partes y 50000/40000 partes.

**Tiempos HTTP cliente en milisegundos (p95 de 7 muestras en cada escala, no p95 de tráfico real):**

| Caso | 5k | 20k | 50k |
| --- | ---: | ---: | ---: |
| `blocked` | 22,191 | 36,852 | 79,038 |
| `human_review` | 18,890 | 39,254 | 74,626 |
| `composed` | 17,313 | 32,224 | 62,367 |

**Tres GET simultáneas** de `blocked` sobre la misma cookie: p95 por petición = **61,052 ms con 20k** y **119,099 ms con 50k**. Las respuestas fueron HTTP 200 y devolvieron exactamente los mismos 50 IDs ordenados, sin datos de otro tenant. Las 9 combinaciones de 5k y las 5 de cada escala superior mantuvieron segunda página real sin duplicados; cursor adulterado o reutilizado con otro sort devolvió 422.

Advertencias: con 7 muestras el p95 y el p99 por nearest-rank representan el máximo observado y NO estiman cuantiles estables de una población. La variabilidad del runner compartido, caché caliente, fixture sintética y la baja concurrencia impiden fijar SLA/GO. Estos tiempos incluyen HTTP loopback, Node, Express, Sequelize, PostGIS y su serialización; **no incluyen TLS/CDN/internet móvil/rural/VPS**, ni equivalen a una comparación con datos productivos.

Este agregado documental cambia el HEAD de la rama: antes de fusionar se requiere volver a ejecutar el CI completo sobre el SHA nuevo y luego uno independiente sobre el commit fusionado en `main`.
