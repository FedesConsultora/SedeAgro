const defaultItems = [
  { title: 'Aplicacion herbicida', field: 'Lote 12 Norte', status: 'Aprobacion pendiente' },
  { title: 'Monitoreo plagas', field: 'San Miguel / Maiz temprano', status: 'Asignado' },
  { title: 'Reporte de campaña', field: 'Soja 25/26', status: 'En preparacion' }
];

export function WorkQueue({ items = defaultItems }) {
  return (
    <section className="panel">
      <div className="panel__header">
        <h2>Ordenes activas</h2>
        <button type="button">Nueva</button>
      </div>
      <div className="work-queue">
        {items.map((item) => (
          <article className="work-item" key={item.title}>
            <div>
              <strong>{item.title}</strong>
              <span>{item.field}</span>
            </div>
            <small>{item.status}</small>
          </article>
        ))}
      </div>
    </section>
  );
}
