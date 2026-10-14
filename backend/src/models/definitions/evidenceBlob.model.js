export function defineEvidenceBlob(sequelize, DataTypes) {
  return sequelize.define('EvidenceBlob', {
    evidence_id: { type: DataTypes.UUID, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    content: { type: DataTypes.BLOB('long'), allowNull: false }
  }, { tableName: 'evidence_blobs' });
}
