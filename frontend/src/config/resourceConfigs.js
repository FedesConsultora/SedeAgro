import { mockData, mockIds } from '../services/mockData.js';

const today = '2026-06-16';
const scheduledAt = '2026-06-20T09:00';

const statusOptions = {
  field: [
    ['active', 'Activo'],
    ['inactive', 'Inactivo'],
    ['archived', 'Archivado']
  ],
  campaign: [
    ['planned', 'Planificada'],
    ['active', 'Activa'],
    ['closed', 'Cerrada'],
    ['archived', 'Archivada']
  ],
  campaignField: [
    ['planned', 'Planificado'],
    ['active', 'Activo'],
    ['harvested', 'Cosechado'],
    ['closed', 'Cerrado']
  ],
  scouting: [
    ['planned', 'Planificado'],
    ['in_progress', 'En curso'],
    ['completed', 'Completado'],
    ['cancelled', 'Cancelado']
  ],
  severity: [
    ['low', 'Baja'],
    ['medium', 'Media'],
    ['high', 'Alta'],
    ['critical', 'Critica']
  ],
  order: [
    ['draft', 'Borrador'],
    ['pending_approval', 'Pendiente'],
    ['approved', 'Aprobada'],
    ['assigned', 'Asignada'],
    ['in_progress', 'En curso'],
    ['completed', 'Completada'],
    ['cancelled', 'Cancelada']
  ],
  priority: [
    ['low', 'Baja'],
    ['normal', 'Normal'],
    ['high', 'Alta'],
    ['urgent', 'Urgente']
  ],
  team: [
    ['field_ops', 'Campo'],
    ['agronomy', 'Agronomia'],
    ['contractor', 'Contratista'],
    ['client', 'Cliente'],
    ['support', 'Soporte']
  ],
  machineryKind: [
    ['tractor', 'Tractor'],
    ['sprayer', 'Pulverizadora'],
    ['seeder', 'Sembradora'],
    ['harvester', 'Cosechadora'],
    ['drone', 'Drone'],
    ['irrigation', 'Riego'],
    ['sensor', 'Sensor'],
    ['vehicle', 'Vehiculo'],
    ['other', 'Otro']
  ],
  assetStatus: [
    ['active', 'Activo'],
    ['maintenance', 'Mantenimiento'],
    ['inactive', 'Inactivo'],
    ['archived', 'Archivado']
  ],
  inputCategory: [
    ['seed', 'Semilla'],
    ['herbicide', 'Herbicida'],
    ['insecticide', 'Insecticida'],
    ['fungicide', 'Fungicida'],
    ['fertilizer', 'Fertilizante'],
    ['adjuvant', 'Coadyuvante'],
    ['biological', 'Biologico'],
    ['other', 'Otro']
  ],
  reportScope: [
    ['field', 'Lote'],
    ['campaign', 'Campaña'],
    ['producer', 'Productor'],
    ['tenant', 'Tenant'],
    ['work_order', 'Orden']
  ],
  reportFormat: [
    ['pdf', 'PDF'],
    ['xlsx', 'XLSX'],
    ['csv', 'CSV']
  ],
  layerType: [
    ['ndvi', 'NDVI'],
    ['gndvi', 'GNDVI'],
    ['rgb', 'RGB'],
    ['evi', 'EVI'],
    ['moisture', 'Humedad'],
    ['other', 'Otra']
  ]
};

const text = (name, label, value = '', extra = {}) => ({ name, label, value, ...extra });
const number = (name, label, value = '', extra = {}) => ({ name, label, value, type: 'number', ...extra });
const select = (name, label, options, value, extra = {}) => ({ name, label, value, type: 'select', options, ...extra });
const textarea = (name, label, value = '', extra = {}) => ({ name, label, value, type: 'textarea', ...extra });
const date = (name, label, value = today, extra = {}) => ({ name, label, value, type: 'date', ...extra });
const dateTime = (name, label, value = scheduledAt, extra = {}) => ({ name, label, value, type: 'datetime-local', ...extra });
const json = (name, label, value = '{}', extra = {}) => ({ name, label, value, type: 'json', ...extra });
const checkbox = (name, label, value = true, extra = {}) => ({ name, label, value, type: 'checkbox', ...extra });

function relationName(record, relation, fallback = 'Sin vinculo') {
  return record?.[relation]?.name || fallback;
}

function campaignFieldName(record) {
  return record?.CampaignField?.Field?.name || record?.Field?.name || record?.field_id || 'Sin lote';
}

function countChildren(record, key) {
  return Array.isArray(record?.[key]) ? record[key].length : 0;
}

export const pageResources = {
  fields: [
    {
      id: 'producers',
      title: 'Productores',
      eyebrow: 'Maestros',
      endpoint: 'GET/POST /farms/producers',
      mock: mockData.producers,
      load: (api) => api.producers(),
      create: (api, payload) => api.createProducer(payload),
      form: [
        text('name', 'Nombre', 'Agro Norte SRL', { required: true }),
        text('tax_id', 'CUIT', '30-70000000-1'),
        text('contact_email', 'Email', 'operaciones@agronorte.test'),
        text('contact_phone', 'Telefono', '+54 2477 555-010'),
        textarea('notes', 'Notas', 'Cliente demo para pruebas')
      ],
      columns: [
        { label: 'Nombre', render: (item) => item.name, strong: true },
        { label: 'CUIT', render: (item) => item.tax_id || '-' },
        { label: 'Email', render: (item) => item.contact_email || '-' },
        { label: 'Telefono', render: (item) => item.contact_phone || '-' }
      ]
    },
    {
      id: 'farms',
      title: 'Establecimientos',
      eyebrow: 'Territorio',
      endpoint: 'GET/POST /farms',
      mock: mockData.farms,
      load: (api) => api.farms(),
      create: (api, payload) => api.createFarm(payload),
      form: [
        text('producer_id', 'Productor ID', mockIds.producer),
        text('name', 'Nombre', 'La Esperanza', { required: true }),
        text('locality', 'Localidad', 'Pergamino'),
        text('province', 'Provincia', 'Buenos Aires'),
        text('country', 'Pais', 'Argentina'),
        textarea('notes', 'Notas', 'Alta operativa')
      ],
      columns: [
        { label: 'Nombre', render: (item) => item.name, strong: true },
        { label: 'Productor', render: (item) => relationName(item, 'Producer') },
        { label: 'Ubicacion', render: (item) => [item.locality, item.province].filter(Boolean).join(', ') || '-' },
        { label: 'Lotes', render: (item) => countChildren(item, 'Fields') }
      ]
    },
    {
      id: 'fields',
      title: 'Lotes',
      eyebrow: 'GIS',
      endpoint: 'GET/POST /fields',
      mock: mockData.fields,
      load: (api) => api.fields(),
      create: (api, payload) => api.createField(payload),
      form: [
        text('farm_id', 'Establecimiento ID', mockIds.farm, { required: true }),
        text('name', 'Nombre', 'Lote 4', { required: true }),
        number('area_hectares', 'Hectareas', 82),
        select('status', 'Estado', statusOptions.field, 'active'),
        textarea('notes', 'Notas', 'Sector norte con buen acceso')
      ],
      columns: [
        { label: 'Lote', render: (item) => item.name, strong: true },
        { label: 'Establecimiento', render: (item) => relationName(item, 'Farm') },
        { label: 'Hectareas', render: (item) => item.area_hectares ?? '-' },
        { label: 'Estado', render: (item) => item.status, variant: 'status' }
      ]
    }
  ],
  campaigns: [
    {
      id: 'campaigns',
      title: 'Campañas',
      eyebrow: 'Plan productivo',
      endpoint: 'GET/POST /campaigns',
      mock: mockData.campaigns,
      load: (api) => api.campaigns(),
      create: (api, payload) => api.createCampaign(payload),
      form: [
        text('name', 'Nombre', 'Campaña gruesa 2026/27', { required: true }),
        number('season_year', 'Año', 2026, { required: true }),
        date('starts_at', 'Inicio', '2026-09-01', { required: true }),
        date('ends_at', 'Fin', '2027-07-30'),
        select('status', 'Estado', statusOptions.campaign, 'planned')
      ],
      columns: [
        { label: 'Nombre', render: (item) => item.name, strong: true },
        { label: 'Año', render: (item) => item.season_year },
        { label: 'Lotes', render: (item) => countChildren(item, 'CampaignFields') },
        { label: 'Estado', render: (item) => item.status, variant: 'status' }
      ]
    },
    {
      id: 'campaign-fields',
      title: 'Lotes de campaña',
      eyebrow: 'Vinculacion',
      endpoint: 'POST /campaigns/:campaignId/fields',
      mock: mockData.campaignFields,
      load: () => ({ data: mockData.campaignFields }),
      create: (api, payload) => {
        const { campaign_id: campaignId, ...body } = payload;
        return api.assignCampaignField(campaignId, body);
      },
      form: [
        text('campaign_id', 'Campaña ID', mockIds.campaign, { required: true }),
        text('field_id', 'Lote ID', mockIds.field, { required: true }),
        text('crop_type_id', 'Cultivo ID', mockIds.cropType, { required: true }),
        date('planting_date', 'Siembra', '2026-11-05'),
        number('expected_yield', 'Rinde esperado', 38),
        select('status', 'Estado', statusOptions.campaignField, 'planned')
      ],
      columns: [
        { label: 'Lote', render: (item) => relationName(item, 'Field', item.field_id), strong: true },
        { label: 'Cultivo', render: (item) => relationName(item, 'CropType', item.crop_type_id) },
        { label: 'Siembra', render: (item) => item.planting_date || '-' },
        { label: 'Estado', render: (item) => item.status, variant: 'status' }
      ]
    }
  ],
  scouting: [
    {
      id: 'scouting-runs',
      title: 'Recorridas',
      eyebrow: 'Monitoreo',
      endpoint: 'GET/POST /scouting/runs',
      mock: mockData.scoutingRuns,
      load: (api) => api.scoutingRuns(),
      create: (api, payload) => api.createScoutingRun(payload),
      form: [
        text('campaign_field_id', 'Lote campaña ID', mockIds.campaignField, { required: true }),
        dateTime('scheduled_at', 'Programado', scheduledAt),
        select('status', 'Estado', statusOptions.scouting, 'planned'),
        textarea('summary', 'Resumen', 'Recorrida por malezas y estado sanitario')
      ],
      columns: [
        { label: 'Lote', render: campaignFieldName, strong: true },
        { label: 'Programado', render: (item) => item.scheduled_at || '-' },
        { label: 'Resumen', render: (item) => item.summary || '-' },
        { label: 'Estado', render: (item) => item.status, variant: 'status' }
      ]
    },
    {
      id: 'observations',
      title: 'Observaciones',
      eyebrow: 'Campo',
      endpoint: 'POST /scouting/runs/:runId/observations',
      mock: mockData.scoutingObservations,
      load: () => ({ data: mockData.scoutingObservations }),
      create: (api, payload) => {
        const { scouting_run_id: runId, ...body } = payload;
        return api.createObservation(runId, body);
      },
      form: [
        text('scouting_run_id', 'Recorrida ID', mockIds.scoutingRun, { required: true }),
        text('field_id', 'Lote ID', mockIds.field, { required: true }),
        select('observation_type', 'Tipo', [
          ['weed', 'Malezas'],
          ['pest', 'Plagas'],
          ['disease', 'Enfermedad'],
          ['phenology', 'Fenologia'],
          ['nutrition', 'Nutricion'],
          ['water', 'Agua'],
          ['general', 'General']
        ], 'weed'),
        select('severity', 'Severidad', statusOptions.severity, 'medium'),
        dateTime('observed_at', 'Observado', '2026-06-16T12:00'),
        textarea('notes', 'Notas', 'Manchones aislados sobre cabecera norte')
      ],
      columns: [
        { label: 'Tipo', render: (item) => item.observation_type, strong: true },
        { label: 'Severidad', render: (item) => item.severity, variant: 'status' },
        { label: 'Observado', render: (item) => item.observed_at || '-' },
        { label: 'Notas', render: (item) => item.notes || '-' }
      ]
    }
  ],
  orders: [
    {
      id: 'work-orders',
      title: 'Ordenes de trabajo',
      eyebrow: 'Ejecucion',
      endpoint: 'GET/POST /work-orders',
      mock: mockData.workOrders,
      load: (api) => api.workOrders(),
      create: (api, payload) => api.createWorkOrder(payload),
      form: [
        text('field_id', 'Lote ID', mockIds.field, { required: true }),
        text('campaign_field_id', 'Lote campaña ID', mockIds.campaignField),
        text('title', 'Titulo', 'Aplicacion selectiva lote 4', { required: true }),
        select('type', 'Tipo', [
          ['application', 'Aplicacion'],
          ['sowing', 'Siembra'],
          ['fertilization', 'Fertilizacion'],
          ['harvest', 'Cosecha'],
          ['irrigation', 'Riego'],
          ['inspection', 'Inspeccion'],
          ['other', 'Otra']
        ], 'application'),
        select('priority', 'Prioridad', statusOptions.priority, 'normal'),
        select('status', 'Estado', statusOptions.order, 'draft'),
        dateTime('due_at', 'Vence', '2026-06-21T13:00'),
        textarea('instructions', 'Instrucciones', 'Controlar cabecera norte')
      ],
      columns: [
        { label: 'Orden', render: (item) => item.title, strong: true },
        { label: 'Lote', render: (item) => relationName(item, 'Field', item.field_id) },
        { label: 'Prioridad', render: (item) => item.priority, variant: 'status' },
        { label: 'Estado', render: (item) => item.status, variant: 'status' }
      ]
    }
  ],
  teams: [
    {
      id: 'teams',
      title: 'Equipos',
      eyebrow: 'Organizacion',
      endpoint: 'GET/POST /teams',
      mock: mockData.teams,
      load: (api) => api.teams(),
      create: (api, payload) => api.createTeam(payload),
      form: [
        text('name', 'Nombre', 'Cuadrilla Norte', { required: true }),
        select('scope', 'Alcance', statusOptions.team, 'field_ops'),
        text('farm_id', 'Establecimiento ID', mockIds.farm),
        textarea('notes', 'Notas', 'Equipo base para aplicaciones y recorridas')
      ],
      columns: [
        { label: 'Nombre', render: (item) => item.name, strong: true },
        { label: 'Alcance', render: (item) => item.scope, variant: 'status' },
        { label: 'Miembros', render: (item) => countChildren(item, 'TeamMembers') },
        { label: 'Notas', render: (item) => item.notes || '-' }
      ]
    },
    {
      id: 'members',
      title: 'Miembros de la Organización',
      eyebrow: 'Usuarios',
      endpoint: 'GET /auth/members',
      mock: [
        { id: '1', role_code: 'tenant_admin', User: { full_name: 'Ana López (Admin)', email: 'admin@agro-demo.test' } },
        { id: '2', role_code: 'scout', User: { full_name: 'Laura Gómez (Scout)', email: 'monitor@agro-demo.test' } }
      ],
      load: (api) => api.members(),
      create: () => Promise.resolve({ data: [] }), // Readonly on MVP workbench
      form: [], // Empty form: managed by onboarding/invitations
      columns: [
        { label: 'Nombre', render: (item) => item.User?.full_name || 'Desconocido', strong: true },
        { label: 'Email', render: (item) => item.User?.email || '-' },
        { label: 'Rol de acceso', render: (item) => item.role_code, variant: 'status' },
        { label: 'Estado', render: (item) => item.User?.status || 'active', variant: 'status' }
      ]
    }
  ],
  assets: [
    {
      id: 'machinery',
      title: 'Maquinaria',
      eyebrow: 'Activos',
      endpoint: 'GET/POST /assets/machinery',
      mock: mockData.machinery,
      load: (api) => api.machinery(),
      create: (api, payload) => api.createMachinery(payload),
      form: [
        text('name', 'Nombre', 'Pulverizadora Pla MAP II', { required: true }),
        select('kind', 'Tipo', statusOptions.machineryKind, 'sprayer'),
        text('brand', 'Marca', 'Pla'),
        text('model', 'Modelo', 'MAP II'),
        text('serial_number', 'Serie', 'PLA-DEMO-001'),
        select('status', 'Estado', statusOptions.assetStatus, 'active'),
        json('metadata', 'Metadata', '{"boom_width_m":32}')
      ],
      columns: [
        { label: 'Nombre', render: (item) => item.name, strong: true },
        { label: 'Tipo', render: (item) => item.kind, variant: 'status' },
        { label: 'Marca', render: (item) => [item.brand, item.model].filter(Boolean).join(' ') || '-' },
        { label: 'Estado', render: (item) => item.status, variant: 'status' }
      ]
    },
    {
      id: 'inputs',
      title: 'Insumos',
      eyebrow: 'Deposito',
      endpoint: 'GET/POST /assets/inputs',
      mock: mockData.inputs,
      load: (api) => api.inputs(),
      create: (api, payload) => api.createInput(payload),
      form: [
        text('name', 'Nombre', 'Glifosato 66%', { required: true }),
        select('category', 'Categoria', statusOptions.inputCategory, 'herbicide'),
        text('unit', 'Unidad', 'l', { required: true }),
        text('active_ingredient', 'Ingrediente activo', 'Glifosato'),
        text('registration_number', 'Registro', 'SENASA-DEMO'),
        json('metadata', 'Metadata', '{}')
      ],
      columns: [
        { label: 'Nombre', render: (item) => item.name, strong: true },
        { label: 'Categoria', render: (item) => item.category, variant: 'status' },
        { label: 'Unidad', render: (item) => item.unit },
        { label: 'Ingrediente', render: (item) => item.active_ingredient || '-' }
      ]
    }
  ],
  reports: [
    {
      id: 'report-templates',
      title: 'Plantillas',
      eyebrow: 'Reportes',
      endpoint: 'GET/POST /reports/templates',
      mock: mockData.reportTemplates,
      load: (api) => api.reportTemplates(),
      create: (api, payload) => api.createReportTemplate(payload),
      form: [
        text('name', 'Nombre', 'Estado de lote', { required: true }),
        text('code', 'Codigo', 'field_status', { required: true }),
        select('scope', 'Alcance', statusOptions.reportScope, 'field'),
        select('format', 'Formato', statusOptions.reportFormat, 'pdf'),
        checkbox('is_active', 'Activa', true),
        json('config', 'Config', '{"sections":["summary","observations","work_orders"]}')
      ],
      columns: [
        { label: 'Nombre', render: (item) => item.name, strong: true },
        { label: 'Codigo', render: (item) => item.code },
        { label: 'Formato', render: (item) => item.format, variant: 'status' },
        { label: 'Activa', render: (item) => item.is_active ? 'si' : 'no', variant: 'status' }
      ]
    },
    {
      id: 'report-runs',
      title: 'Ejecuciones',
      eyebrow: 'Cola',
      endpoint: 'GET/POST /reports/runs',
      mock: mockData.reportRuns,
      load: (api) => api.reportRuns(),
      create: (api, payload) => api.createReportRun(payload),
      form: [
        text('report_template_id', 'Plantilla ID', mockIds.reportTemplate, { required: true }),
        date('period_start', 'Desde', '2026-06-01'),
        date('period_end', 'Hasta', '2026-06-16'),
        json('filters', 'Filtros', `{"field_id":"${mockIds.field}"}`)
      ],
      columns: [
        { label: 'Plantilla', render: (item) => item.ReportTemplate?.name || item.report_template_id, strong: true },
        { label: 'Desde', render: (item) => item.period_start || '-' },
        { label: 'Hasta', render: (item) => item.period_end || '-' },
        { label: 'Estado', render: (item) => item.status || 'queued', variant: 'status' }
      ]
    }
  ],
  imagery: [
    {
      id: 'satellite-layers',
      title: 'Capas satelitales',
      eyebrow: 'Imagery',
      endpoint: 'GET/POST /imagery/layers',
      mock: mockData.satelliteLayers,
      load: (api) => api.satelliteLayers(),
      create: (api, payload) => api.createSatelliteLayer(payload),
      form: [
        text('field_id', 'Lote ID', mockIds.field, { required: true }),
        text('provider', 'Proveedor', 'Sentinel-2', { required: true }),
        select('layer_type', 'Capa', statusOptions.layerType, 'ndvi'),
        dateTime('captured_at', 'Captura', '2026-06-12T14:00', { required: true }),
        text('storage_key', 'Storage key', 'demo/lote-4/ndvi-2026-06-12.tif', { required: true }),
        json('metadata', 'Metadata', '{"cloud_cover":0.08}')
      ],
      columns: [
        { label: 'Lote', render: (item) => relationName(item, 'Field', item.field_id), strong: true },
        { label: 'Proveedor', render: (item) => item.provider },
        { label: 'Capa', render: (item) => item.layer_type, variant: 'status' },
        { label: 'Captura', render: (item) => item.captured_at || '-' }
      ]
    }
  ],
  sync: [
    {
      id: 'sync-batches',
      title: 'Batches offline',
      eyebrow: 'Sincronizacion',
      endpoint: 'GET/POST /sync/batches',
      mock: mockData.syncBatches,
      load: (api) => api.syncBatches(),
      create: (api, payload) => api.submitSyncBatch(payload),
      form: [
        text('client_id', 'Cliente', 'mobile-demo', { required: true }),
        text('device_id', 'Dispositivo', 'iphone-demo'),
        json('operations', `[{"entity_type":"scouting_observation","operation":"create","payload":{"field_id":"${mockIds.field}","severity":"medium"}}]`, { required: true })
      ],
      columns: [
        { label: 'Cliente', render: (item) => item.client_id, strong: true },
        { label: 'Dispositivo', render: (item) => item.device_id || '-' },
        { label: 'Operaciones', render: (item) => countChildren(item, 'SyncOperations') || countChildren(item, 'operations') },
        { label: 'Estado', render: (item) => item.status, variant: 'status' }
      ]
    }
  ]
};

export const moduleCopy = {
  fields: ['Establecimientos y lotes', 'GIS operativo'],
  campaigns: ['Campañas', 'Plan productivo'],
  scouting: ['Monitoreo', 'Recorridas y observaciones'],
  orders: ['Ordenes de trabajo', 'Ejecucion'],
  teams: ['Equipos', 'Organizacion'],
  assets: ['Activos e insumos', 'Inventario'],
  reports: ['Reportes', 'Salidas operativas'],
  imagery: ['Satelite', 'Capas por lote'],
  sync: ['Sincronizacion', 'Offline first']
};
