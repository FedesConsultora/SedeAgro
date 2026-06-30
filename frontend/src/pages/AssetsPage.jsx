import { useEffect, useState } from 'react';
import { Tractor, Box, ShieldAlert, CheckCircle2, AlertTriangle, Plus, Trash2, Edit3 } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { Modal } from '../components/Modal.jsx';

const STATUS_ES = { active: 'Activo', maintenance: 'Mantenimiento', inactive: 'Inactivo', archived: 'Archivado' };
const STATUS_COLORS = { active: 'green', maintenance: 'amber', inactive: 'slate', archived: 'gray' };

const KIND_ES = {
  tractor: 'Tractor',
  sprayer: 'Pulverizadora',
  seeder: 'Sembradora',
  harvester: 'Cosechadora',
  drone: 'Drone',
  irrigation: 'Equipo de riego',
  sensor: 'Sensor IoT',
  vehicle: 'Vehículo',
  other: 'Otro'
};

const CATEGORIES_ES = {
  seed: 'Semilla',
  herbicide: 'Herbicida',
  insecticide: 'Insecticida',
  fungicide: 'Fungicida',
  fertilizer: 'Fertilizante',
  adjuvant: 'Coadyuvante',
  biological: 'Biológico',
  other: 'Otro'
};

export function AssetsPage() {
  const { api, dataMode } = useSession();
  const [activeTab, setActiveTab] = useState('machinery');
  const [machinery, setMachinery] = useState([]);
  const [inputs, setInputs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showMachineryModal, setShowMachineryModal] = useState(false);
  const [showInputModal, setShowInputModal] = useState(false);

  const loadData = async () => {
    setLoading(true);
    if (dataMode === 'mock') {
      setMachinery(mockData.machinery || []);
      setInputs(mockData.inputs || []);
      setLoading(false);
      return;
    }
    try {
      const [machineryRes, inputsRes] = await Promise.all([
        api.machinery(),
        api.inputs()
      ]);
      setMachinery(machineryRes.data || []);
      setInputs(inputsRes.data || []);
    } catch {
      setMachinery(mockData.machinery || []);
      setInputs(mockData.inputs || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [api, dataMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateMachinery = async (body) => {
    if (dataMode === 'mock') {
      const newMock = {
        id: `mock-mac-${Date.now()}`,
        name: body.name,
        kind: body.kind,
        brand: body.brand,
        model: body.model,
        serial_number: body.serial_number,
        status: body.status,
        metadata: {}
      };
      setMachinery(prev => [newMock, ...prev]);
      setShowMachineryModal(false);
      return;
    }
    try {
      await api.createMachinery(body);
      loadData();
      setShowMachineryModal(false);
    } catch { /* Handled globally by the API feedback hook */ }
  };

  const handleCreateInput = async (body) => {
    if (dataMode === 'mock') {
      const newMock = {
        id: `mock-inp-${Date.now()}`,
        name: body.name,
        category: body.category,
        unit: body.unit,
        active_ingredient: body.active_ingredient,
        registration_number: body.registration_number,
        metadata: {}
      };
      setInputs(prev => [newMock, ...prev]);
      setShowInputModal(false);
      return;
    }
    try {
      await api.createInput(body);
      loadData();
      setShowInputModal(false);
    } catch { /* Handled globally */ }
  };

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Recursos productivos</span>
          <h1>Activos e insumos</h1>
        </div>
        <div>
          {activeTab === 'machinery' ? (
            <button type="button" className="primary-action" onClick={() => setShowMachineryModal(true)}>
              <Plus size={16} /> Alta de maquinaria
            </button>
          ) : (
            <button type="button" className="primary-action" onClick={() => setShowInputModal(true)}>
              <Plus size={16} /> Alta de insumo
            </button>
          )}
        </div>
      </section>

      {/* Tabs Menu */}
      <nav className="admin-tabs" style={{ background: 'rgba(255, 255, 255, 0.4)' }}>
        <button
          type="button"
          className={`admin-tabs__tab ${activeTab === 'machinery' ? 'admin-tabs__tab--active' : ''}`}
          onClick={() => setActiveTab('machinery')}
        >
          <Tractor size={15} />
          <span>Maquinarias y sensores</span>
        </button>
        <button
          type="button"
          className={`admin-tabs__tab ${activeTab === 'inputs' ? 'admin-tabs__tab--active' : ''}`}
          onClick={() => setActiveTab('inputs')}
        >
          <Box size={15} />
          <span>Insumos y depósito</span>
        </button>
      </nav>

      {/* Tab Panel */}
      <div className="admin-panel">
        {loading ? (
          <div className="empty-state"><span>Cargando recursos…</span></div>
        ) : activeTab === 'machinery' ? (
          /* MACHINERY VIEW */
          <div className="admin-tab-content" style={{ padding: 0 }}>
            <div className="admin-table">
              <div className="admin-table__head" style={{ gridTemplateColumns: '2fr 1fr 1.5fr 1fr 80px' }}>
                <span>Maquinaria / Sensor</span>
                <span>Tipo</span>
                <span>Marca y modelo</span>
                <span>Estado</span>
                <span>Acciones</span>
              </div>
              {machinery.length === 0 ? (
                <div className="empty-state" style={{ padding: 48 }}>
                  <Tractor size={32} />
                  <h3>Sin maquinarias</h3>
                  <p>Registrá tus tractores, sembradoras o sensores IoT.</p>
                </div>
              ) : (
                machinery.map((m) => (
                  <div key={m.id} className="admin-table__row" style={{ gridTemplateColumns: '2fr 1fr 1.5fr 1fr 80px' }}>
                    <span>
                      <strong>{m.name}</strong>
                      {m.serial_number && <div className="admin-table__sub">S/N: {m.serial_number}</div>}
                    </span>
                    <span>
                      <span className="status-badge status-badge--blue">{KIND_ES[m.kind] || m.kind}</span>
                    </span>
                    <span>{m.brand} {m.model || ''}</span>
                    <span>
                      <span className={`status-badge status-badge--${STATUS_COLORS[m.status] || 'slate'}`}>
                        {STATUS_ES[m.status] || m.status}
                      </span>
                    </span>
                    <span className="admin-table__actions">
                      <button type="button" className="ghost-action ghost-action--sm" title="Editar">
                        <Edit3 size={12} />
                      </button>
                      <button type="button" className="ghost-action ghost-action--sm ghost-action--danger" title="Archivar">
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          /* INPUTS VIEW */
          <div className="admin-tab-content" style={{ padding: 0 }}>
            <div className="admin-table">
              <div className="admin-table__head" style={{ gridTemplateColumns: '2.5fr 1.5fr 1.5fr 1fr 80px' }}>
                <span>Insumo</span>
                <span>Categoría</span>
                <span>Ingrediente Activo</span>
                <span>Unidad</span>
                <span>Acciones</span>
              </div>
              {inputs.length === 0 ? (
                <div className="empty-state" style={{ padding: 48 }}>
                  <Box size={32} />
                  <h3>Sin insumos</h3>
                  <p>Registrá tus semillas, fertilizantes y defensivos agrícolas.</p>
                </div>
              ) : (
                inputs.map((inp) => (
                  <div key={inp.id} className="admin-table__row" style={{ gridTemplateColumns: '2.5fr 1.5fr 1.5fr 1fr 80px' }}>
                    <strong>{inp.name}</strong>
                    <span>
                      <span className="status-badge status-badge--blue">{CATEGORIES_ES[inp.category] || inp.category}</span>
                    </span>
                    <span className="admin-table__muted">{inp.active_ingredient || '–'}</span>
                    <span style={{ fontFamily: 'monospace' }}>{inp.unit}</span>
                    <span className="admin-table__actions">
                      <button type="button" className="ghost-action ghost-action--sm" title="Editar">
                        <Edit3 size={12} />
                      </button>
                      <button type="button" className="ghost-action ghost-action--sm ghost-action--danger" title="Eliminar">
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Machinery Modal */}
      {showMachineryModal && (
        <Modal open={showMachineryModal} onClose={() => setShowMachineryModal(false)} title="Agregar Maquinaria / Sensor">
          <MachineryForm onSubmit={handleCreateMachinery} onCancel={() => setShowMachineryModal(false)} />
        </Modal>
      )}

      {/* Input Modal */}
      {showInputModal && (
        <Modal open={showInputModal} onClose={() => setShowInputModal(false)} title="Agregar Insumo">
          <InputForm onSubmit={handleCreateInput} onCancel={() => setShowInputModal(false)} />
        </Modal>
      )}
    </div>
  );
}

function MachineryForm({ onSubmit, onCancel }) {
  const [form, setForm] = useState({
    name: '',
    kind: 'tractor',
    brand: '',
    model: '',
    serial_number: '',
    status: 'active'
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}>
      <div className="form-row">
        <label className="form-field">
          <span>Nombre *</span>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="Tractor John Deere 6125" />
        </label>
        <label className="form-field">
          <span>Tipo *</span>
          <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
            {Object.entries(KIND_ES).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-row">
        <label className="form-field">
          <span>Marca</span>
          <input value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} placeholder="John Deere" />
        </label>
        <label className="form-field">
          <span>Modelo</span>
          <input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} placeholder="6125J" />
        </label>
      </div>

      <div className="form-row">
        <label className="form-field">
          <span>Número de serie / Serie</span>
          <input value={form.serial_number} onChange={e => setForm({ ...form, serial_number: e.target.value })} placeholder="SN-123456" />
        </label>
        <label className="form-field">
          <span>Estado inicial *</span>
          <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
            {Object.entries(STATUS_ES).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="ghost-action" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="primary-action">Guardar</button>
      </div>
    </form>
  );
}

function InputForm({ onSubmit, onCancel }) {
  const [form, setForm] = useState({
    name: '',
    category: 'herbicide',
    unit: 'l',
    active_ingredient: '',
    registration_number: ''
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}>
      <div className="form-row">
        <label className="form-field">
          <span>Nombre *</span>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="Glifosato 66%" />
        </label>
        <label className="form-field">
          <span>Categoría *</span>
          <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
            {Object.entries(CATEGORIES_ES).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-row">
        <label className="form-field">
          <span>Ingrediente activo</span>
          <input value={form.active_ingredient} onChange={e => setForm({ ...form, active_ingredient: e.target.value })} placeholder="Glifosato" />
        </label>
        <label className="form-field">
          <span>Unidad de medida *</span>
          <input value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} required placeholder="l, kg, uds" />
        </label>
      </div>

      <label className="form-field">
        <span>Nro de Registro (SENASA u otro)</span>
        <input value={form.registration_number} onChange={e => setForm({ ...form, registration_number: e.target.value })} placeholder="SENASA-32948" />
      </label>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
        <button type="button" className="ghost-action" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="primary-action">Guardar</button>
      </div>
    </form>
  );
}
