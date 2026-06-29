/**
 * Seed demo users across all tenant roles for testing.
 *
 * Creates:
 *   - 1 tenant "Agro Demo" (slug: agro-demo)
 *   - 5 users, one per tenant role
 *   - Memberships linking each user to the tenant with their role
 *   - TenantModules from the starter plan
 *
 * All users share password: SedeAgro2026!
 *
 * ┌─────────────────────────────────┬──────────────────────────┬───────────────────────┐
 * │ Email                           │ Rol                      │ Password              │
 * ├─────────────────────────────────┼──────────────────────────┼───────────────────────┤
 * │ admin@agro-demo.test            │ tenant_admin             │ SedeAgro2026!         │
 * │ coordinador@agro-demo.test      │ agronomic_coordinator    │ SedeAgro2026!         │
 * │ monitor@agro-demo.test          │ scout                    │ SedeAgro2026!         │
 * │ contratista@agro-demo.test      │ contractor               │ SedeAgro2026!         │
 * │ productor@agro-demo.test        │ producer_viewer          │ SedeAgro2026!         │
 * └─────────────────────────────────┴──────────────────────────┴───────────────────────┘
 */

import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const keyLength = 64;

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, keyLength);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

const DEMO_PASSWORD = 'SedeAgro2026!';
const TENANT_SLUG = 'agro-demo';
const TENANT_NAME = 'Agro Demo';
const PLAN_CODE = 'starter';

const demoUsers = [
  { email: 'admin@agro-demo.test',       fullName: 'Ana López (Admin)',       role: 'tenant_admin' },
  { email: 'coordinador@agro-demo.test',  fullName: 'Carlos Martínez (Coord)', role: 'agronomic_coordinator' },
  { email: 'monitor@agro-demo.test',      fullName: 'Laura Gómez (Scout)',     role: 'scout' },
  { email: 'contratista@agro-demo.test',  fullName: 'Pedro Ruiz (Contratista)', role: 'contractor' },
  { email: 'productor@agro-demo.test',    fullName: 'María Torres (Productor)', role: 'producer_viewer' }
];

// Demo data: producer, farm, fields, campaign, campaign-field, scouting, work order
const DEMO_PRODUCER = { name: 'Agro Norte SRL', tax_id: '30-70000000-1', contact_email: 'operaciones@agronorte.test' };

const DEMO_FARMS = [
  { name: 'La Esperanza', locality: 'Pergamino', province: 'Buenos Aires', country: 'Argentina' },
  { name: 'San Miguel', locality: 'Venado Tuerto', province: 'Santa Fe', country: 'Argentina' }
];

const DEMO_FIELDS = [
  { farmIndex: 0, name: 'Lote 4',          area_hectares: 82,  status: 'active', notes: 'Sector norte con buen acceso' },
  { farmIndex: 0, name: 'Lote 12 Norte',   area_hectares: 64,  status: 'active', notes: 'Trigo en macollaje' },
  { farmIndex: 1, name: 'Lote 9',          area_hectares: 145, status: 'active', notes: 'Seguimiento semanal' }
];

export async function up({ context: queryInterface }) {
  const sql = queryInterface.sequelize;

  // 1. Hash the shared password
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // 2. Get the plan
  const [[plan]] = await sql.query(
    `SELECT id FROM plans WHERE code = :planCode AND is_active = true LIMIT 1`,
    { replacements: { planCode: PLAN_CODE } }
  );
  if (!plan) throw new Error(`Plan "${PLAN_CODE}" not found. Run base seed first.`);

  // 3. Create tenant
  await sql.query(`
    INSERT INTO tenants(name, slug, billing_email, plan_id, status)
    VALUES (:name, :slug, :billingEmail, :planId, 'active')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, status = 'active';
  `, { replacements: { name: TENANT_NAME, slug: TENANT_SLUG, billingEmail: demoUsers[0].email, planId: plan.id } });

  const [[tenant]] = await sql.query(`SELECT id FROM tenants WHERE slug = :slug LIMIT 1`, { replacements: { slug: TENANT_SLUG } });

  // 4. Enable modules for tenant
  await sql.query(`
    INSERT INTO tenant_modules(tenant_id, module_code, is_enabled, source)
    SELECT :tenantId, pm.module_code, true, 'plan'
    FROM plan_modules pm
    WHERE pm.plan_id = :planId
    ON CONFLICT (tenant_id, module_code) DO NOTHING;
  `, { replacements: { tenantId: tenant.id, planId: plan.id } });

  // 5. Create users & memberships
  for (const u of demoUsers) {
    const isPlatformAdmin = u.email === 'admin@agro-demo.test';
    await sql.query(`
      INSERT INTO users(email, full_name, password_hash, status, is_platform_admin)
      VALUES (:email, :fullName, :passwordHash, 'active', :isPlatformAdmin)
      ON CONFLICT (email) DO UPDATE SET 
        password_hash = EXCLUDED.password_hash, 
        full_name = EXCLUDED.full_name, 
        status = 'active',
        is_platform_admin = EXCLUDED.is_platform_admin;
    `, { replacements: { email: u.email, fullName: u.fullName, passwordHash, isPlatformAdmin } });

    const [[user]] = await sql.query(`SELECT id FROM users WHERE email = :email LIMIT 1`, { replacements: { email: u.email } });

    await sql.query(`
      INSERT INTO memberships(tenant_id, user_id, role_code, status, joined_at)
      VALUES (:tenantId, :userId, :role, 'active', NOW())
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_code = EXCLUDED.role_code, status = 'active';
    `, { replacements: { tenantId: tenant.id, userId: user.id, role: u.role } });
  }

  // 6. Create demo producer
  await sql.query(`
    INSERT INTO producers(tenant_id, name, tax_id, contact_email)
    VALUES (:tenantId, :name, :taxId, :email)
    ON CONFLICT DO NOTHING;
  `, { replacements: { tenantId: tenant.id, name: DEMO_PRODUCER.name, taxId: DEMO_PRODUCER.tax_id, email: DEMO_PRODUCER.contact_email } });

  const [[producer]] = await sql.query(`SELECT id FROM producers WHERE tenant_id = :tenantId AND name = :name LIMIT 1`,
    { replacements: { tenantId: tenant.id, name: DEMO_PRODUCER.name } });

  // 7. Create farms
  const farmIds = [];
  for (const farm of DEMO_FARMS) {
    await sql.query(`
      INSERT INTO farms(tenant_id, producer_id, name, locality, province, country)
      VALUES (:tenantId, :producerId, :name, :locality, :province, :country)
      ON CONFLICT DO NOTHING;
    `, { replacements: { tenantId: tenant.id, producerId: producer.id, ...farm } });

    const [[row]] = await sql.query(`SELECT id FROM farms WHERE tenant_id = :tenantId AND name = :name LIMIT 1`,
      { replacements: { tenantId: tenant.id, name: farm.name } });
    farmIds.push(row.id);
  }

  // 8. Create fields
  const fieldIds = [];
  for (const field of DEMO_FIELDS) {
    await sql.query(`
      INSERT INTO fields(tenant_id, farm_id, name, area_hectares, status, notes)
      VALUES (:tenantId, :farmId, :name, :area, :status, :notes)
      ON CONFLICT DO NOTHING;
    `, { replacements: { tenantId: tenant.id, farmId: farmIds[field.farmIndex], name: field.name, area: field.area_hectares, status: field.status, notes: field.notes } });

    const [[row]] = await sql.query(`SELECT id FROM fields WHERE tenant_id = :tenantId AND name = :name LIMIT 1`,
      { replacements: { tenantId: tenant.id, name: field.name } });
    fieldIds.push(row.id);
  }

  // 9. Create campaign
  const year = new Date().getFullYear();
  await sql.query(`
    INSERT INTO campaigns(tenant_id, name, season_year, starts_at, ends_at, status)
    VALUES (:tenantId, :name, :year, :starts, :ends, 'active')
    ON CONFLICT DO NOTHING;
  `, { replacements: { tenantId: tenant.id, name: `Campaña gruesa ${year}/${year + 1}`, year, starts: `${year}-09-01`, ends: `${year + 1}-07-31` } });

  const [[campaign]] = await sql.query(`SELECT id FROM campaigns WHERE tenant_id = :tenantId ORDER BY created_at DESC LIMIT 1`,
    { replacements: { tenantId: tenant.id } });

  // 10. Get crop types
  const [[cropSoja]] = await sql.query(`SELECT id FROM crop_types WHERE code = 'soy' LIMIT 1`);

  // 11. Assign first field to campaign
  await sql.query(`
    INSERT INTO campaign_fields(tenant_id, campaign_id, field_id, crop_type_id, planting_date, expected_yield, status)
    VALUES (:tenantId, :campaignId, :fieldId, :cropTypeId, :plantingDate, 38, 'active')
    ON CONFLICT DO NOTHING;
  `, { replacements: { tenantId: tenant.id, campaignId: campaign.id, fieldId: fieldIds[0], cropTypeId: cropSoja.id, plantingDate: `${year}-11-05` } });

  const [[campaignField]] = await sql.query(`SELECT id FROM campaign_fields WHERE tenant_id = :tenantId AND campaign_id = :campaignId LIMIT 1`,
    { replacements: { tenantId: tenant.id, campaignId: campaign.id } });

  // 12. Get scout user for assignment
  const [[scoutUser]] = await sql.query(`SELECT id FROM users WHERE email = 'monitor@agro-demo.test' LIMIT 1`);

  // 13. Create scouting run
  await sql.query(`
    INSERT INTO scouting_runs(tenant_id, campaign_field_id, assigned_to, scheduled_at, status, summary)
    VALUES (:tenantId, :cfId, :assignedTo, :scheduledAt, 'planned', 'Recorrida por malezas y estado sanitario')
    ON CONFLICT DO NOTHING;
  `, { replacements: { tenantId: tenant.id, cfId: campaignField.id, assignedTo: scoutUser.id, scheduledAt: new Date().toISOString() } });

  // 14. Create work order
  await sql.query(`
    INSERT INTO work_orders(tenant_id, field_id, campaign_field_id, title, type, status, priority, due_at, instructions)
    VALUES (:tenantId, :fieldId, :cfId, 'Aplicación selectiva lote 4', 'application', 'assigned', 'high',
            :dueAt, 'Controlar cabecera norte y registrar evidencia fotográfica')
    ON CONFLICT DO NOTHING;
  `, { replacements: { tenantId: tenant.id, fieldId: fieldIds[0], cfId: campaignField.id, dueAt: new Date(Date.now() + 3 * 86400000).toISOString() } });

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  SedeAgro — Cuentas de prueba creadas ✓                        ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  Tenant: Agro Demo (agro-demo)                                 ║');
  console.log('║  Password compartida: SedeAgro2026!                             ║');
  console.log('╠──────────────────────────────────┬───────────────────────────────╣');
  console.log('║  Email                           │ Rol                          ║');
  console.log('╠──────────────────────────────────┼───────────────────────────────╣');
  console.log('║  admin@agro-demo.test            │ Administrador                ║');
  console.log('║  coordinador@agro-demo.test      │ Coordinador agronómico       ║');
  console.log('║  monitor@agro-demo.test          │ Monitoreador                 ║');
  console.log('║  contratista@agro-demo.test      │ Contratista                  ║');
  console.log('║  productor@agro-demo.test        │ Productor / cliente          ║');
  console.log('╚══════════════════════════════════╧═══════════════════════════════╝\n');
}

export async function down({ context: queryInterface }) {
  const sql = queryInterface.sequelize;
  const [[tenant]] = await sql.query(`SELECT id FROM tenants WHERE slug = :slug LIMIT 1`, { replacements: { slug: TENANT_SLUG } });
  if (!tenant) return;

  await sql.query(`DELETE FROM work_orders WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });
  await sql.query(`DELETE FROM scouting_observations WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });
  await sql.query(`DELETE FROM scouting_runs WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });
  await sql.query(`DELETE FROM campaign_fields WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });
  await sql.query(`DELETE FROM campaigns WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });
  await sql.query(`DELETE FROM fields WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });
  await sql.query(`DELETE FROM farms WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });
  await sql.query(`DELETE FROM producers WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });
  await sql.query(`DELETE FROM memberships WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });
  await sql.query(`DELETE FROM tenant_modules WHERE tenant_id = :tid`, { replacements: { tid: tenant.id } });

  const emails = demoUsers.map((u) => u.email);
  await sql.query(`DELETE FROM users WHERE email IN (:emails)`, { replacements: { emails } });
  await sql.query(`DELETE FROM tenants WHERE slug = :slug`, { replacements: { slug: TENANT_SLUG } });
}
