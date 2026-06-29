export const mockIds = {
  producer: '11111111-1111-4111-8111-111111111111',
  farm: '22222222-2222-4222-8222-222222222222',
  farmAlt: '22222222-2222-4222-8222-222222222223',
  field: '33333333-3333-4333-8333-333333333333',
  fieldAlt: '33333333-3333-4333-8333-333333333334',
  campaign: '44444444-4444-4444-8444-444444444444',
  campaignField: '55555555-5555-4555-8555-555555555555',
  cropType: '66666666-6666-4666-8666-666666666666',
  cropTypeAlt: '66666666-6666-4666-8666-666666666667',
  scoutingRun: '77777777-7777-4777-8777-777777777777',
  observation: '88888888-8888-4888-8888-888888888888',
  workOrder: '99999999-9999-4999-8999-999999999999',
  team: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  machine: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  input: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  reportTemplate: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  reportRun: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  satelliteLayer: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  syncBatch: '12345678-1234-4234-8234-123456789abc'
};

const fieldLaEsperanza = {
  id: mockIds.field,
  farm_id: mockIds.farm,
  name: 'Lote 4',
  area_hectares: 82,
  status: 'active',
  notes: 'Sector norte con buen acceso',
  Farm: {
    id: mockIds.farm,
    name: 'La Esperanza',
    province: 'Buenos Aires',
    locality: 'Pergamino'
  }
};

const fieldSanMiguel = {
  id: mockIds.fieldAlt,
  farm_id: mockIds.farmAlt,
  name: 'Lote 9',
  area_hectares: 145,
  status: 'active',
  notes: 'Seguimiento semanal por alerta temprana',
  Farm: {
    id: mockIds.farmAlt,
    name: 'San Miguel',
    province: 'Santa Fe',
    locality: 'Venado Tuerto'
  }
};

const cropSoja = {
  id: mockIds.cropType,
  name: 'Soja',
  code: 'SOJA'
};

const cropMaiz = {
  id: mockIds.cropTypeAlt,
  name: 'Maiz',
  code: 'MAIZ'
};

export const mockData = {
  producers: [
    {
      id: mockIds.producer,
      name: 'Agro Norte SRL',
      tax_id: '30-70000000-1',
      contact_email: 'operaciones@agronorte.test',
      contact_phone: '+54 2477 555-010',
      notes: 'Cliente demo para pruebas operativas'
    }
  ],
  farms: [
    {
      id: mockIds.farm,
      producer_id: mockIds.producer,
      name: 'La Esperanza',
      locality: 'Pergamino',
      province: 'Buenos Aires',
      country: 'Argentina',
      Producer: { id: mockIds.producer, name: 'Agro Norte SRL' },
      Fields: [fieldLaEsperanza]
    },
    {
      id: mockIds.farmAlt,
      producer_id: mockIds.producer,
      name: 'San Miguel',
      locality: 'Venado Tuerto',
      province: 'Santa Fe',
      country: 'Argentina',
      Producer: { id: mockIds.producer, name: 'Agro Norte SRL' },
      Fields: [fieldSanMiguel]
    }
  ],
  fields: [
    fieldLaEsperanza,
    fieldSanMiguel,
    {
      id: '33333333-3333-4333-8333-333333333335',
      farm_id: mockIds.farm,
      name: 'Lote 12 Norte',
      area_hectares: 64,
      status: 'active',
      notes: 'Trigo en macollaje',
      Farm: {
        id: mockIds.farm,
        name: 'La Esperanza',
        province: 'Buenos Aires',
        locality: 'Pergamino'
      }
    }
  ],
  cropTypes: [cropSoja, cropMaiz],
  campaignFields: [
    {
      id: mockIds.campaignField,
      campaign_id: mockIds.campaign,
      field_id: mockIds.field,
      crop_type_id: mockIds.cropType,
      planting_date: '2026-11-05',
      expected_yield: 38,
      status: 'active',
      Field: fieldLaEsperanza,
      CropType: cropSoja
    }
  ],
  campaigns: [
    {
      id: mockIds.campaign,
      name: 'Campaña gruesa 2026/27',
      season_year: 2026,
      starts_at: '2026-09-01',
      ends_at: '2027-07-30',
      status: 'active',
      CampaignFields: [
        {
          id: mockIds.campaignField,
          Field: fieldLaEsperanza,
          CropType: cropSoja,
          status: 'active'
        }
      ]
    }
  ],
  scoutingRuns: [
    {
      id: mockIds.scoutingRun,
      campaign_field_id: mockIds.campaignField,
      assigned_to: null,
      scheduled_at: '2026-06-20T09:00:00.000Z',
      status: 'planned',
      summary: 'Recorrida por malezas y estado sanitario',
      CampaignField: {
        id: mockIds.campaignField,
        Field: fieldLaEsperanza,
        CropType: cropSoja
      }
    }
  ],
  scoutingObservations: [
    {
      id: mockIds.observation,
      scouting_run_id: mockIds.scoutingRun,
      field_id: mockIds.field,
      observation_type: 'weed',
      severity: 'medium',
      observed_at: '2026-06-16T12:00:00.000Z',
      notes: 'Manchones aislados sobre cabecera norte'
    }
  ],
  workOrders: [
    {
      id: mockIds.workOrder,
      field_id: mockIds.field,
      campaign_field_id: mockIds.campaignField,
      title: 'Aplicacion selectiva lote 4',
      type: 'application',
      status: 'assigned',
      priority: 'high',
      due_at: '2026-06-21T13:00:00.000Z',
      instructions: 'Controlar cabecera norte y registrar evidencia',
      Field: fieldLaEsperanza
    }
  ],
  teams: [
    {
      id: mockIds.team,
      name: 'Cuadrilla Norte',
      scope: 'field_ops',
      farm_id: mockIds.farm,
      notes: 'Equipo base para aplicaciones y recorridas',
      TeamMembers: []
    }
  ],
  machinery: [
    {
      id: mockIds.machine,
      name: 'Pulverizadora Pla MAP II',
      kind: 'sprayer',
      brand: 'Pla',
      model: 'MAP II',
      serial_number: 'PLA-DEMO-001',
      status: 'active',
      metadata: { boom_width_m: 32 }
    }
  ],
  inputs: [
    {
      id: mockIds.input,
      name: 'Glifosato 66%',
      category: 'herbicide',
      unit: 'l',
      active_ingredient: 'Glifosato',
      registration_number: 'SENASA-DEMO',
      metadata: {}
    }
  ],
  reportTemplates: [
    {
      id: mockIds.reportTemplate,
      name: 'Estado de lote',
      code: 'field_status',
      scope: 'field',
      format: 'pdf',
      is_active: true,
      config: { sections: ['summary', 'observations', 'work_orders'] }
    }
  ],
  reportRuns: [
    {
      id: mockIds.reportRun,
      report_template_id: mockIds.reportTemplate,
      status: 'queued',
      period_start: '2026-06-01',
      period_end: '2026-06-16',
      ReportTemplate: {
        id: mockIds.reportTemplate,
        name: 'Estado de lote',
        code: 'field_status',
        format: 'pdf'
      }
    }
  ],
  satelliteLayers: [
    {
      id: mockIds.satelliteLayer,
      field_id: mockIds.field,
      provider: 'Sentinel-2',
      layer_type: 'ndvi',
      captured_at: '2026-06-12T14:00:00.000Z',
      storage_key: 'demo/lote-4/ndvi-2026-06-12.tif',
      metadata: { cloud_cover: 0.08 },
      Field: fieldLaEsperanza
    }
  ],
  syncBatches: [
    {
      id: mockIds.syncBatch,
      client_id: 'mobile-demo',
      device_id: 'iphone-demo',
      status: 'received',
      received_at: '2026-06-16T12:15:00.000Z',
      SyncOperations: [
        {
          id: '12345678-1234-4234-8234-123456789abd',
          entity_type: 'scouting_observation',
          operation: 'create'
        }
      ]
    }
  ],
  notifications: [
    {
      id: 'abcdefab-1234-4234-8234-abcdefabcdef',
      title: 'Orden asignada',
      body: 'Aplicacion selectiva lote 4',
      read_at: null,
      created_at: '2026-06-16T12:30:00.000Z'
    }
  ]
};
