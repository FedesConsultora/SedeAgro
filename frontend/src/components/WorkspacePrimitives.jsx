import { LoaderCircle } from 'lucide-react';
import './workspace-primitives.css';

// Consistent reading order and actions, without prescribing any agronomic
// metric. Modules retain their own RBAC/entitlement decisions.
export function WorkspaceHeading({ eyebrow, title, actions }) {
  return (
    <header className="page-heading workspace-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
      </div>
      {actions && <div className="workspace-heading__actions">{actions}</div>}
    </header>
  );
}

export function CollectionState({ status, title, description, icon: Icon, action }) {
  if (!['loading', 'empty', 'filtered'].includes(status)) return null;
  const isLoading = status === 'loading';
  return (
    <section className="empty-state collection-state"
      role={isLoading ? 'status' : 'region'}
      aria-label={isLoading ? 'Cargando información' : title}
      aria-live={isLoading ? 'polite' : undefined} aria-busy={isLoading}>
      {isLoading
        ? <LoaderCircle className="collection-state__loader" size={30} aria-hidden="true" />
        : Icon ? <Icon size={36} aria-hidden="true" /> : null}
      <h3>{isLoading ? 'Cargando información…' : title}</h3>
      {!isLoading && description && <p>{description}</p>}
      {!isLoading && action}
    </section>
  );
}
