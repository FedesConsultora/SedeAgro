# 0S.18 — Autoridad de sesión entre pestañas (TOP → SedeAgro)

## Contrato

Una pestaña que cambió de usuario/empresa o cerró sesión **no concede permisos a otra**.
El aviso `sedeagro-auth-transitions-v1` es solo una señal: tres campos
(`kind`, `source`, `nonce`) sin usuario, tenant, token, cookie, ubicación,
observaciones ni datos de campo. `BroadcastChannel` más `storage` (el evento
opaco se elimina de localStorage de inmediato); el receptor deduplica ambos.

La pestaña receptora:
1. **Antes de consultar red**, reemplaza su representación de sesión por una
   anónima, incrementa epoch y desmonta pantallas privadas. No borra IndexedDB.
2. Lee el `sedeagro.tenantHint` actual (no el capturado al iniciar la pestaña)
   y revalida la cookie **real** mediante `GET /api/v1/auth/me`.
3. Exige usuario, membresía y tenant coincidente. Solo el backend establece
   el nuevo usuario, entitlement y rol. Resultados vencidos por nuevas
   transiciones o por una respuesta tardía se descartan mediante epoch +
   secuencia de revalidación.
4. Ante 401/403/404, muestra Login, sin restaurar vistas viejas. Ante caída de
   red, 5xx o perfil inválido, mantiene bloqueada la vista y ofrece Reintentar;
   vuelve a probar tras evento `online`.
5. También revalida al volver al primer plano tras 60 segundos, inspirado en
   `apps/web/src/features/auth/foreground-revalidation.ts` de TOP. Si está
   offline, la vuelta a la pestaña **no** destruye el trabajo de campo activo.

## Cierre de sesión

El evento se publica **solo después** de `POST /auth/logout` exitoso.
Si falla el servidor, SedeAgro conserva la sesión y solicita reintento; no
afirma revocación. Una respuesta 401 de una generación actual también avisa
a las demás pestañas; un 401 de una generación anterior se ignora. La
revocación de PostgreSQL y la comprobación RLS de cada request siguen siendo
fuente de autoridad, no el estado React ni el bus del navegador.

## Cobertura

- `frontend/test/sessionTabSync.test.js`: ausencia de secretos, deduplicación,
  respaldo storage, desuscripción y foreground/offline.
- `frontend/test/sessionTabWiring.test.js`: cuarentena previa a la API,
  bloqueo honesto y protección por generación.
- `scripts/acceptance-browser-evidence-history.mjs`: dos pestañas reales con
  cookie HttpOnly, logout servidor, cambio de tenant y usuario por registro
  real, error 503 temporal, recuperación verificada y regreso al primer
  tenant con consulta nueva de evidencias.

## Límites explícitos

No es prueba física en Safari/iPhone, Android ni red rural. No significa que
una pestaña totalmente suspendida reciba eventos sin delay; `visibilitychange`,
`focus` y `pageshow` agregan revalidación acotada al reanudarse. Un
documento con sesión revocada externamente no puede saberlo sin consultar a
Express. No se borran fotos, notas, colas AES-GCM ni claves de borradores por
cambios de cuenta; siguen particionadas por scope y sujetas a CAS de 0S.10.

Sin migraciones, despliegue, cambios de roles/RLS ni afirmaciones de
producción lista. Gate: tests frontend y navegador real junto con backend RLS.
