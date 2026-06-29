import { uuidPk } from './_shared.js';

export function defineEvidenceAsset(sequelize, DataTypes) {
  return sequelize.define('EvidenceAsset', {
    id: uuidPk(DataTypes),
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    scouting_observation_id: DataTypes.UUID,
    work_order_id: DataTypes.UUID,
    uploaded_by: DataTypes.UUID,
    kind: { type: DataTypes.STRING(24), allowNull: false },
    storage_key: { type: DataTypes.TEXT, allowNull: false },
    original_name: DataTypes.STRING(240),
    mime_type: DataTypes.STRING(120),
    size_bytes: DataTypes.INTEGER,
    captured_at: DataTypes.DATE,
    point: DataTypes.GEOMETRY('POINT', 4326)
  }, { tableName: 'evidence_assets' });
}
