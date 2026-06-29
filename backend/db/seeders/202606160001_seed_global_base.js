const modules = [
  ['org', 'Base organizacional', 'Tenants, usuarios, membresías, roles y auditoría', true],
  ['gis', 'GIS de campos y lotes', 'Establecimientos, lotes, polígonos y consultas geoespaciales', true],
  ['campaigns', 'Campañas y cultivos', 'Planificación temporal por cultivo y campaña', true],
  ['scouting', 'Monitoreo de campo', 'Recorridas, observaciones, waypoints y evidencias', true],
  ['work_orders', 'Órdenes de trabajo', 'Flujo dato-diagnóstico-acción con responsables y estados', true],
  ['analytics', 'Panel analítico', 'KPIs, mapas, semáforos e historial operativo', true],
  ['imagery', 'Imágenes satelitales', 'NDVI, GNDVI, RGB y comparativos temporales', false],
  ['water', 'Lluvias y riego', 'Registros manuales, sensores y visualización por lote', false],
  ['integrations', 'Integraciones', 'ERP, maquinaria, sensores y proveedores externos', false],
  ['reports', 'Reportes automáticos', 'PDF, Excel y envíos programados', true]
];

const roles = [
  ['platform_admin', 'Administrador de plataforma', 'platform', 'Gestiona tenants, planes y auditoría global.'],
  ['platform_support', 'Soporte de plataforma', 'platform', 'Acceso global de lectura para soporte.'],
  ['tenant_admin', 'Administrador de empresa', 'tenant', 'Configura usuarios, campos, campañas y reglas del tenant.'],
  ['agronomic_coordinator', 'Coordinador agronómico', 'tenant', 'Planifica campañas y supervisa órdenes.'],
  ['scout', 'Monitoreador', 'tenant', 'Carga observaciones y evidencias a campo.'],
  ['contractor', 'Contratista', 'tenant', 'Ejecuta órdenes de trabajo y reporta avance.'],
  ['producer_viewer', 'Productor / cliente', 'tenant', 'Consulta panel, reportes e historial autorizado.']
];

const permissions = [
  ['tenant.manage', 'Administrar configuración del tenant'],
  ['members.manage', 'Administrar membresías y roles'],
  ['farms.manage', 'Administrar establecimientos y lotes'],
  ['campaigns.manage', 'Administrar campañas y cultivos'],
  ['scouting.manage', 'Crear y revisar monitoreos'],
  ['work_orders.manage', 'Crear, aprobar y asignar órdenes'],
  ['reports.read', 'Leer reportes y analítica'],
  ['platform.manage', 'Administrar plataforma completa']
];

const tenantAdminPermissions = [
  'tenant.manage',
  'members.manage',
  'farms.manage',
  'campaigns.manage',
  'scouting.manage',
  'work_orders.manage',
  'reports.read'
];

const cropTypes = [
  ['soy', 'Soja'],
  ['corn', 'Maíz'],
  ['wheat', 'Trigo'],
  ['sunflower', 'Girasol'],
  ['barley', 'Cebada'],
  ['sorghum', 'Sorgo'],
  ['pasture', 'Pastura']
];

export async function up({ context: queryInterface }) {
  const sql = queryInterface.sequelize;

  for (const [code, name, description, isStarter] of modules) {
    await sql.query(`
      INSERT INTO modules(code, name, description, is_starter)
      VALUES (:code, :name, :description, :isStarter)
      ON CONFLICT (code) DO UPDATE
      SET name = EXCLUDED.name,
          description = EXCLUDED.description,
          is_starter = EXCLUDED.is_starter;
    `, { replacements: { code, name, description, isStarter } });
  }

  for (const [code, name, scope, description] of roles) {
    await sql.query(`
      INSERT INTO roles(code, name, scope, description)
      VALUES (:code, :name, :scope, :description)
      ON CONFLICT (code) DO UPDATE
      SET name = EXCLUDED.name,
          scope = EXCLUDED.scope,
          description = EXCLUDED.description;
    `, { replacements: { code, name, scope, description } });
  }

  for (const [code, description] of permissions) {
    await sql.query(`
      INSERT INTO permissions(code, description)
      VALUES (:code, :description)
      ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;
    `, { replacements: { code, description } });
  }

  await sql.query(`
    INSERT INTO role_permissions(role_code, permission_code)
    VALUES ('platform_admin', 'platform.manage')
    ON CONFLICT DO NOTHING;
  `);

  for (const permission of tenantAdminPermissions) {
    await sql.query(`
      INSERT INTO role_permissions(role_code, permission_code)
      VALUES ('tenant_admin', :permission)
      ON CONFLICT DO NOTHING;
    `, { replacements: { permission } });
  }

  for (const permission of ['farms.manage', 'campaigns.manage', 'scouting.manage', 'work_orders.manage', 'reports.read']) {
    await sql.query(`
      INSERT INTO role_permissions(role_code, permission_code)
      VALUES ('agronomic_coordinator', :permission)
      ON CONFLICT DO NOTHING;
    `, { replacements: { permission } });
  }

  for (const permission of ['scouting.manage']) {
    await sql.query(`
      INSERT INTO role_permissions(role_code, permission_code)
      VALUES ('scout', :permission)
      ON CONFLICT DO NOTHING;
    `, { replacements: { permission } });
  }

  for (const permission of ['work_orders.manage']) {
    await sql.query(`
      INSERT INTO role_permissions(role_code, permission_code)
      VALUES ('contractor', :permission)
      ON CONFLICT DO NOTHING;
    `, { replacements: { permission } });
  }

  await sql.query(`
    INSERT INTO role_permissions(role_code, permission_code)
    VALUES ('producer_viewer', 'reports.read')
    ON CONFLICT DO NOTHING;
  `);

  await sql.query(`
    INSERT INTO plans(code, name, max_users, limits)
    VALUES ('starter', 'Starter Agro', 8, '{"storage_gb": 5, "fields_max": 100}'::jsonb)
    ON CONFLICT (code) DO UPDATE
    SET name = EXCLUDED.name,
        max_users = EXCLUDED.max_users,
        limits = EXCLUDED.limits,
        is_active = true;
  `);

  await sql.query(`
    INSERT INTO plan_modules(plan_id, module_code)
    SELECT p.id, m.code
    FROM plans p
    CROSS JOIN modules m
    WHERE p.code = 'starter'
      AND m.is_starter = true
    ON CONFLICT DO NOTHING;
  `);

  for (const [code, name] of cropTypes) {
    await sql.query(`
      INSERT INTO crop_types(code, name)
      VALUES (:code, :name)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;
    `, { replacements: { code, name } });
  }
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    DELETE FROM crop_types WHERE code IN ('soy', 'corn', 'wheat', 'sunflower', 'barley', 'sorghum', 'pasture');
    DELETE FROM plan_modules WHERE module_code IN (SELECT code FROM modules);
    DELETE FROM role_permissions;
    DELETE FROM permissions;
    DELETE FROM roles;
    DELETE FROM modules;
    DELETE FROM plans WHERE code = 'starter';
  `);
}
