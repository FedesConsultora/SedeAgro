# 0T.1 — Contratos visuales, accesibilidad y verdad operativa

Referencia: plan `docs/product/top-adoption-matrix-20261015.md` y patrones de
presentación desacoplados de TOP (`PageHeader` / `EmptyState`). El objetivo
es aplicar contratos, **no** copiar interfaz, negocio de gimnasio ni módulos
de TOP a SedeAgro.

## Entrega

1. `WorkspaceHeading` y `CollectionState` comparten semántica de encabezados
   y estados de consulta `loading`, `empty` y `filtered`. Usados en
   Establecimientos, Campañas y Reportes. No reemplazan los errores reales
   emitidos por `ResourceLoadNotice`. Una respuesta fallida no es colección
   vacía, ni un filtro sin coincidencias significa que no existen datos.
2. Expansores de establecimientos/campañas ahora son botones nativos
   `aria-expanded`/`aria-controls` separados de Nuevo lote/Asignar lote;
   ya no hay botón dentro de otro botón/rol clickable simulado.
3. Modal y Drawer tienen `role=dialog`, `aria-modal`, nombre anunciado,
   foco inicial dentro del diálogo, ciclo Tab/Shift+Tab, Escape y retorno
   al disparador si sigue conectado. La pila evita que un diálogo inferior
   capture el teclado de uno superior. Activos y la invitación de ejemplo
   en Equipos usan el contrato correcto `isOpen` (antes pasaban `open`).
4. Formularios reales de establecimiento y órdenes no suplantan fallos del
   backend con `mockData.producers` o `mockData.fields`. Distinguen
   loading/error/retry, rechazan respuestas malformadas, cancelan efectos al
   desmontar y evitan enviar formularios con lotes desconocidos.

## Autoridad y alcance

- Backend, PostgreSQL RLS, permisos y cookies siguen siendo la autoridad.
- CTA de creación de Establecimientos y Campañas continúa limitado a
  coordinadores y tenant admin. Invitación de equipos continúa **solo demo**;
  no se afirma que exista API real de invitación.
- No se borran borradores AES-GCM ni se altera la sincronización offline.
- El estilo a 320–680 px reduce padding de superficies y permite wrap de
  acciones. `prefers-reduced-motion` deshabilita animaciones de estos
  elementos. No sustituye una revisión de Safari/iOS/Android físicos.

## Comprobaciones reproducibles

- `npm test --workspace @sedeagro/frontend`: pruebas de contrato de 0T.1 y
  regresiones anteriores.
- `npm run build --workspace @sedeagro/frontend`.
- GitHub Actions `tenant-rls`: base PostgreSQL/PostGIS desechable, pruebas
  reales Chromium de cookie, formularios fail-closed y regresiones RLS.
- `browser-offline`: cifrado IndexedDB y reload offline en Chromium.
- Cerrar únicamente si ambos jobs están en SUCCESS sobre HEAD exacto del PR,
  y volver a controlar en `main` tras merge.

## No cubierto aún

Auditoría visual de TODOS los módulos, screen reader real, Safari/iOS/Android
físicos, 200% zoom, conexiones rurales, staging y despliegue productivo.
Estos temas siguen en 0T.2 / 0T.3 y bloques posteriores de 0T.1 si aparecen
regresiones funcionales concretas.
