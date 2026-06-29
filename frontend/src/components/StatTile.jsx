export function StatTile({ label, value, tone = 'green', icon: Icon }) {
  return (
    <article className={`stat-tile stat-tile--${tone}`}>
      <div className="stat-tile__header">
        <span className="stat-tile__label">{label}</span>
        {Icon && (
          <div className="stat-tile__icon-wrapper">
            <Icon size={18} />
          </div>
        )}
      </div>
      <strong className="stat-tile__value">{value}</strong>
    </article>
  );
}
