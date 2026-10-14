// Do not invent agronomic measurements when remote-sensing metadata is absent.
export function cloudCoverLabel(value) {
  const number = Number(value);
  return (value == null || value === '') || !Number.isFinite(number) || number < 0 || number > 1
    ? 'No informado' : (number * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + '%';
}

export function ndviMeanLabel(value) {
  const number = Number(value);
  return (value == null || value === '') || !Number.isFinite(number) || number < -1 || number > 1
    ? 'No informado' : number.toLocaleString('es-AR', { maximumFractionDigits: 3 });
}
