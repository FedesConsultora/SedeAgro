// P0 pilot: invitations remain pending until the recipient proves control of
// an invitation secret AND chooses their own credentials (or verifies existing).
export async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    CREATE TABLE member_invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email citext NOT NULL,
      role_code varchar(80) NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
      token_hash char(64) NOT NULL UNIQUE,
      status varchar(24) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','revoked')),
      expires_at timestamptz NOT NULL,
      invited_by uuid NOT NULL,
      accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
      accepted_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT member_invitation_inviter_tenant_fk
        FOREIGN KEY (tenant_id, invited_by)
        REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE,
      CONSTRAINT member_invitation_role_safe_ck
        CHECK (role_code IN ('scout','contractor','agronomic_coordinator','producer_viewer'))
    );
    CREATE UNIQUE INDEX member_invitation_pending_email
      ON member_invitations(tenant_id, email) WHERE status='pending';
    CREATE INDEX member_invitation_tenant_state
      ON member_invitations(tenant_id, status, expires_at);
    ALTER TABLE member_invitations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE member_invitations FORCE ROW LEVEL SECURITY;
    CREATE POLICY member_invitations_tenant_isolation ON member_invitations
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id());
  `);
}

export async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query('DROP TABLE IF EXISTS member_invitations;');
}
