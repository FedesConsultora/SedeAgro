import { useEffect, useState } from 'react';
import { Satellite, Calendar, AlertTriangle, Eye, Compass, Layers } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { mockData } from '../services/mockData.js';
import { Modal } from '../components/Modal.jsx';

const LAYER_ES = {
  ndvi: 'NDVI (Índice Verde)',
  gndvi: 'GNDVI (Humedad de Hoja)',
  rgb: 'Color Real (RGB)',
  evi: 'EVI (Vigor de Biomasa)',
  moisture: 'Estrés Hídrico',
  other: 'Otro'
};

export function SatellitePage() {
  const { api, dataMode } = useSession();
  const [layers, setLayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedLayer, setSelectedLayer] = useState(null);
  const [showCompare, setShowCompare] = useState(false);

  const loadData = async () => {
    setLoading(true);
    if (dataMode === 'mock') {
      setLayers(mockData.satelliteLayers || []);
      setLoading(false);
      return;
    }
    try {
      const res = await api.satelliteLayers();
      setLayers(res.data || []);
    } catch {
      setLayers(mockData.satelliteLayers || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [api, dataMode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page-grid">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Sensores remotos</span>
          <h1>Monitoreo Satelital</h1>
        </div>
      </section>

      {/* Grid Layout: Map Simulation + List */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>
        
        {/* Mock Map Panel */}
        <div className="map-panel" style={{ padding: 0, height: 400, overflow: 'hidden', position: 'relative' }}>
          <div style={{
            position: 'absolute', top: 12, left: 12, zIndex: 10,
            background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(8px)',
            padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, color: '#334155',
            boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
          }}>
            Vista Satelital: {selectedLayer ? LAYER_ES[selectedLayer.layer_type] : 'Ninguna capa activa'}
          </div>

          <div style={{
            width: '100%', height: '100%',
            background: selectedLayer ? 'linear-gradient(135deg, #065f46 0%, #047857 50%, #065f46 100%)' : '#334155',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flexDirection: 'column', gap: 8,
            transition: 'background 0.5s ease'
          }}>
            {selectedLayer ? (
              <>
                <Satellite size={48} className="spin-slow" style={{ opacity: 0.3, marginBottom: 12 }} />
                <span style={{ fontSize: 13, fontWeight: 700 }}>{selectedLayer.Field?.name || 'Lote'} - {new Date(selectedLayer.captured_at).toLocaleDateString('es-AR')}</span>
                <span style={{ fontSize: 11, opacity: 0.8 }}>NDVI Promedio: 0.72 · Nubosidad: {(selectedLayer.metadata?.cloud_cover * 100 || 8).toFixed(1)}%</span>
              </>
            ) : (
              <>
                <Layers size={48} style={{ opacity: 0.2, marginBottom: 12 }} />
                <span style={{ fontSize: 13, opacity: 0.7 }}>Seleccioná una capa satelital del panel lateral</span>
              </>
            )}
          </div>
        </div>

        {/* Sidebar Layers List */}
        <div className="admin-panel" style={{ padding: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Satellite size={16} /> Capas Disponibles
          </h3>

          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>Cargando capas…</div>
          ) : layers.length === 0 ? (
            <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>No hay capas procesadas en esta campaña.</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {layers.map((layer) => (
                <div
                  key={layer.id}
                  className={`admin-role-card ${selectedLayer?.id === layer.id ? 'admin-role-card--active' : ''}`}
                  style={{
                    padding: 12, cursor: 'pointer',
                    borderColor: selectedLayer?.id === layer.id ? '#059669' : undefined,
                    background: selectedLayer?.id === layer.id ? 'rgba(5, 150, 105, 0.04)' : undefined
                  }}
                  onClick={() => setSelectedLayer(layer)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                    <strong style={{ fontSize: 12, color: '#1e293b' }}>
                      {layer.Field?.name || 'Lote'}
                    </strong>
                    <span className="status-badge status-badge--blue" style={{ fontSize: 9, padding: '1px 4px' }}>
                      {layer.provider || 'Sentinel-2'}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#64748b', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{LAYER_ES[layer.layer_type] || layer.layer_type}</span>
                    <span>{layer.captured_at ? new Date(layer.captured_at).toLocaleDateString('es-AR') : '–'}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
