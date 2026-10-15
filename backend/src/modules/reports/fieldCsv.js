// A bounded, server-derived CSV snapshot. No client-supplied SQL/columns.
// Excel and other spreadsheet programs must never execute user-written notes.
export const FIELD_CSV_MAX_ROWS_PER_KIND = 200;
export const FIELD_CSV_MAX_BYTES = 1024 * 1024;

export function parseFieldCsvDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Fecha inválida: usá AAAA-MM-DD.');
  }
  const parsed = new Date(date + 'T00:00:00.000Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('Fecha inexistente en el calendario.');
  }
  return parsed;
}

export function fieldCsvPeriod(from, to) {
  const start = from ? parseFieldCsvDate(from) : null;
  const end = to ? parseFieldCsvDate(to) : null;
  if (start && end && end < start) throw new Error('La fecha final debe ser posterior o igual a la inicial.');
  const exclusiveEnd = end ? new Date(end.getTime() + 86400000) : null;
  return { start, exclusiveEnd, from: from || null, to: to || null };
}

export function csvSafeCell(input) {
  const value = input == null ? '' : String(input).replace(/\0/g, '');
  // Prefix a quote when the first non-whitespace character is a spreadsheet
  // formula marker. Quotes alone do not disable formula evaluation in Excel.
  const escaped = /^[\s\uFEFF]*[=+\-@]/u.test(value) ? "'" + value : value;
  return '"' + escaped.replace(/"/g, '""') + '"';
}

const COLUMNS = [
  'tipo_registro','id','fecha_utc','lote','establecimiento',
  'categoria','estado','prioridad','detalle'
];

function iso(input) {
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export function buildFieldCsv({ field, observations, workOrders }) {
  if (!field?.id || !Array.isArray(observations) || !Array.isArray(workOrders) ||
      observations.length > FIELD_CSV_MAX_ROWS_PER_KIND ||
      workOrders.length > FIELD_CSV_MAX_ROWS_PER_KIND) {
    throw new Error('Reporte sin lote válido o demasiadas filas.');
  }
  const name = field.name || '';
  const farm = field.Farm?.name || '';
  const rows = [
    COLUMNS,
    ['lote', field.id, '', name, farm, 'hectareas', '', '',
      field.area_hectares ?? ''],
    ...observations.map(item => [
      'observacion', item.id, iso(item.observed_at), name, farm,
      item.observation_type, item.severity, '', item.notes || ''
    ]),
    ...workOrders.map(item => [
      'orden', item.id, iso(item.created_at), name, farm,
      item.type, item.status, item.priority, item.title
    ])
  ];
  const csv = '\uFEFF' + rows.map(row => row.map(csvSafeCell).join(',')).join('\r\n') + '\r\n';
  if (Buffer.byteLength(csv, 'utf8') > FIELD_CSV_MAX_BYTES) {
    throw new Error('El reporte supera 1 MiB. Elegí un período más corto.');
  }
  return csv;
}
