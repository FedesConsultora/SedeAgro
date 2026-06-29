export function uuidPk(DataTypes) {
  return {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  };
}
