import { EndpointWorkbench } from '../components/EndpointWorkbench.jsx';
import { moduleCopy, pageResources } from '../config/resourceConfigs.js';

export function OperationsPage({ mode }) {
  const [title, eyebrow] = moduleCopy[mode] || moduleCopy.campaigns;
  const resources = pageResources[mode] || pageResources.campaigns;

  return (
    <div className="page-grid">
      <section className="page-heading">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </section>
      {resources.map((resource) => (
        <EndpointWorkbench key={resource.id} resource={resource} />
      ))}
    </div>
  );
}
