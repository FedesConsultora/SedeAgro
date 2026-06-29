import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FlaskConical,
  Plus,
  RefreshCw,
  Send,
  Server
} from 'lucide-react';
import { useFeedback } from '../context/FeedbackContext.jsx';
import { useSession } from '../context/SessionContext.jsx';

function unwrap(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (response?.data) return [response.data];
  return [];
}

function cloneMock(items) {
  return (items || []).map((item) => ({ ...item }));
}

function makeInitialValues(form) {
  return (form || []).reduce((values, field) => ({
    ...values,
    [field.name]: field.value ?? ''
  }), {});
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'si' : 'no';
  if (typeof value === 'number') return value.toLocaleString('es-AR');
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' && value.includes('T')) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  }
  return value;
}

function serializeForm(form, values) {
  return form.reduce((payload, field) => {
    const rawValue = values[field.name];

    if ((rawValue === '' || rawValue === undefined || rawValue === null) && !field.required) {
      return payload;
    }

    if (field.type === 'number') {
      return { ...payload, [field.name]: Number(rawValue) };
    }

    if (field.type === 'json') {
      return { ...payload, [field.name]: JSON.parse(rawValue || (field.required ? '[]' : '{}')) };
    }

    if (field.type === 'checkbox') {
      return { ...payload, [field.name]: Boolean(rawValue) };
    }

    return { ...payload, [field.name]: rawValue };
  }, {});
}

function statusMeta(source, dataMode) {
  if (source === 'live') return { icon: Server, label: 'Backend', tone: 'live' };
  if (source === 'fallback') return { icon: AlertTriangle, label: 'Mock fallback', tone: 'fallback' };
  if (dataMode === 'live') return { icon: Database, label: 'Backend', tone: 'live' };
  return { icon: FlaskConical, label: 'Mock', tone: 'mock' };
}

function renderInput(field, value, onChange, inputId) {
  const commonProps = {
    id: inputId,
    name: field.name,
    value: value ?? '',
    required: field.required,
    onChange: (event) => onChange(field.name, event.target.value)
  };

  if (field.type === 'select') {
    return (
      <select {...commonProps}>
        {field.options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    );
  }

  if (field.type === 'textarea' || field.type === 'json') {
    return <textarea {...commonProps} rows={field.type === 'json' ? 4 : 3} />;
  }

  if (field.type === 'checkbox') {
    return (
      <label className="checkbox-field" htmlFor={inputId}>
        <input
          id={inputId}
          name={field.name}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(field.name, event.target.checked)}
        />
        <span>{field.label}</span>
      </label>
    );
  }

  return <input {...commonProps} type={field.type || 'text'} />;
}

export function EndpointWorkbench({ resource }) {
  const { api, dataMode } = useSession();
  const feedback = useFeedback();
  const [items, setItems] = useState(() => cloneMock(resource.mock));
  const [source, setSource] = useState(dataMode);
  const [isBusy, setIsBusy] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(true);
  const [formValues, setFormValues] = useState(() => makeInitialValues(resource.form));

  const meta = useMemo(() => statusMeta(source, dataMode), [source, dataMode]);
  const StatusIcon = meta.icon;

  const loadResource = useCallback(async () => {
    if (dataMode === 'mock') {
      setItems(cloneMock(resource.mock));
      setSource('mock');
      return;
    }

    setIsBusy(true);
    try {
      const response = await resource.load(api);
      setItems(unwrap(response));
      setSource('live');
    } catch {
      setItems(cloneMock(resource.mock));
      setSource('fallback');
    } finally {
      setIsBusy(false);
    }
  }, [api, dataMode, resource]);

  useEffect(() => {
    loadResource();
  }, [loadResource]);

  const handleValueChange = (name, value) => {
    setFormValues((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    let payload;
    try {
      payload = serializeForm(resource.form, formValues);
    } catch {
      feedback.showError({
        title: 'JSON invalido',
        message: 'Revisa el campo JSON antes de enviar.'
      });
      return;
    }

    if (dataMode === 'mock') {
      const mockRecord = {
        id: `mock-${Date.now()}`,
        ...payload
      };
      setItems((current) => [mockRecord, ...current]);
      setFormValues(makeInitialValues(resource.form));
      return;
    }

    setIsBusy(true);
    try {
      const response = await resource.create(api, payload);
      setItems((current) => [...unwrap(response), ...current]);
      setFormValues(makeInitialValues(resource.form));
      setSource('live');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <section className="resource-panel">
      <div className="resource-panel__header">
        <div>
          <span className="eyebrow">{resource.eyebrow}</span>
          <h2>{resource.title}</h2>
          <span className="endpoint-label">{resource.endpoint}</span>
        </div>
        <div className="resource-panel__actions">
          <span className={`endpoint-status endpoint-status--${meta.tone}`}>
            <StatusIcon size={15} />
            {meta.label}
          </span>
          <button type="button" className="icon-button" onClick={loadResource} title="Actualizar" disabled={isBusy}>
            <RefreshCw size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setIsFormOpen((current) => !current)}
            title="Nuevo"
          >
            <Plus size={17} />
          </button>
        </div>
      </div>

      <div className={isFormOpen ? 'resource-panel__body' : 'resource-panel__body resource-panel__body--table-only'}>
        <div className="resource-table" role="table" aria-label={resource.title}>
          <div className="resource-table__row resource-table__row--head" role="row">
            {resource.columns.map((column) => (
              <span role="columnheader" key={column.label}>{column.label}</span>
            ))}
          </div>
          {items.map((item, index) => (
            <div className="resource-table__row" role="row" key={item.id || `${resource.id}-${index}`}>
              {resource.columns.map((column) => {
                const value = column.render(item);
                return (
                  <span
                    role="cell"
                    key={column.label}
                    className={column.variant === 'status' ? 'status-pill' : undefined}
                  >
                    {column.strong ? <strong>{formatValue(value)}</strong> : formatValue(value)}
                  </span>
                );
              })}
            </div>
          ))}
          {!items.length && (
            <div className="resource-table__empty">
              <CheckCircle2 size={18} />
              <span>Sin registros</span>
            </div>
          )}
        </div>

        {isFormOpen && (
          <form className="resource-form" onSubmit={handleSubmit}>
            <div className="resource-form__title">
              <Send size={16} />
              <span>Crear registro</span>
            </div>
            {resource.form.map((field) => (
              <div className={field.type === 'checkbox' ? 'form-field form-field--checkbox' : 'form-field'} key={field.name}>
                {field.type !== 'checkbox' && <label htmlFor={`resource-field-${resource.id}-${field.name}`}>{field.label}</label>}
                {renderInput(field, formValues[field.name], handleValueChange, `resource-field-${resource.id}-${field.name}`)}
              </div>
            ))}
            <button type="submit" className="primary-action" disabled={isBusy}>
              <Send size={16} />
              Enviar
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
