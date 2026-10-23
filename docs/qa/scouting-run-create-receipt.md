# PILOT-SCOUTING-RUN-CREATE-ACK — Alta segura de recorridas

**Alcance:** frontend de \`Nueva recorrida de monitoreo\`, sin cambios de servidor, JWT, RLS, tablas, cola offline o infra. Base de trabajo \`main@098fb9049f7e10999b38bd958a7929cdc7a6c03c\`; coordinación #18; matriz de piloto #166; release #130 sigue NO-GO.

## Defecto detectado leyendo main

\`ScoutingRunFormModal\` usaba sólo el estado React \`saving\` para impedir doble submit. Dos eventos antes del próximo render podían ejecutar dos \`POST /scouting/runs\` y crear recorridas con UUID distintos. El formulario consideraba exitosa cualquier promesa resuelta sin verificar la identidad de la recorrida devuelta. \`campaignFields()\` y \`scoutingAssignees()\` dependían sólo de cancelación en un efecto, pero podían conservar nombres privados del tenant previo hasta que corriera el siguiente efecto.

## Nuevo contrato en el navegador

- Sólo sesiones \`live\` autenticadas con usuario/tenant y rol tenant_admin o agronomic_coordinator, más entitlement \`scouting\`, pueden solicitar opciones o guardar. El backend sigue aplicando \`scouting.plan\`, membresía activa y FORCE RLS. La UI no concede permisos.
- Listas de lotes de campaña y responsables se unen al mismo scope, identidad de API y apertura del formulario. Una respuesta lenta de otra identidad/rol no puede volver a mostrarse. Estructuras inválidas se rechazan y hay reintento manual de lectura.
- Antes del primer \`await\` de creación se adquiere un ticket síncrono por formulario. No se acepta un segundo POST, ni una segunda creación tras un ACK confirmado, sin cerrar y abrir la ventana.
- El ACK del servidor debe contener UUID de recorrida válido, tenant, vínculo al lote/campaña exacto, responsable elegido, estado inicial, hora normalizada cuando se envió y resumen cuando se envió. Un 2xx genérico no basta.
- Después de **cualquier POST despachado** sin acuse completo, el estado queda \`uncertain\`: se bloquea el botón y se pide cerrar, actualizar Recorridas y revisar posibles altas antes de intentar otra. No hay retry automático ni afirmación exactly-once.
- Cerrar con Cancelar, X, Escape o overlay se impide durante la solicitud en curso. Un éxito del usuario/tenant anterior no puede completar el modal de una cuenta nueva.
- Sin backend (modo demo) el formulario no simula una recorrida guardada.

## Verificación de código

\`frontend/test/scoutingRunCreateSafety.test.js\`: prueba scopes por tenant/usuario/rol/membresía/entitlements, doble evento asíncrono antes de render, confirmación, respuesta ambigua, respuesta de tenant/lote/responsable/estado/fecha/resumen incorrectos y wiring del modal.

## Aceptación pendiente con backend real

1. Autenticarse como coordinador del tenant A en staging autorizado. Crear una recorrida con fecha, responsable y resumen; recargar la lista y comprobar **una sola fila** y asignación coherente.
2. Enviar dos toques rápidos en móvil; comprobar una sola solicitud y una sola fila. Repetir con timeout artificial después de enviar y simular ACK perdido: el formulario exige revisar la lista, sin auto-reintento.
3. Cambiar de tenant o cuenta mientras se cargan lotes/responsables; no deben verse opciones ajenas ni permitir submit. Repetir durante el POST; el acuse tardío anterior no debe afectar la identidad actual.
4. Roles scout/contractor/producer o entitlement revocado no ven opciones de planificación; el servidor debe rechazar POST directo no autorizado, conservando RLS.
5. Verificar creación planificada sin asignado, y en curso con asignado. Error de fecha inválida no despacha POST.

**Límites:** la API no acepta clave idempotente persistente en la creación de recorridas. Un refresco de pestaña u otro dispositivo aún podría emitir un POST duplicado; el guard cubre sólo una apertura del formulario. La prueba CI del helper no certifica el dispositivo real, ni un 2xx confirma la persistencia final ante caída/rollback externo. \`MOB-05 #163\`, revisión de seguridad y staging/Android/iOS siguen pendientes. Sin deploy autorizado.
