import { EndpointWorkbench } from '../components/EndpointWorkbench.jsx';
import { moduleCopy, pageResources } from '../config/resourceConfigs.js';

export function FieldsPage() {
  const [title, eyebrow] = moduleCopy.fields;

  return (
    <div className="page-grid">
      <section className="page-heading">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </section>
      {pageResources.fields.map((resource) => (
        <EndpointWorkbench key={resource.id} resource={resource} />
      ))}
    </div>
  );
}
