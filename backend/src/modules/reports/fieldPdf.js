// Valid PDF 1.4 (A4, WinAnsi Type1 Helvetica) generated from a real,
// tenant-authorized bounded database snapshot. No binary dependencies.
const PAGE_WIDTH = 595, PAGE_HEIGHT = 842;
const LEFT = 42, TOP = 784, LINE_HEIGHT = 12, LINES_PER_PAGE = 56;
const MAX_PAGES = 80, MAX_PDF_BYTES = 3 * 1024 * 1024;
const EXTRA_WINANSI = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85],
  ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a],
  ['‹', 0x8b], ['Œ', 0x8c], ['Ž', 0x8e], ['‘', 0x91], ['’', 0x92],
  ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
  ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c],
  ['ž', 0x9e], ['Ÿ', 0x9f]
]);
export function encodePdfWinAnsi(value) {
  const characters = String(value ?? '').normalize('NFC');
  const bytes = [];
  for (const ch of characters) {
    const code = ch.codePointAt(0);
    if (ch === '\t') { bytes.push(32); continue; }
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
      bytes.push(code); continue;
    }
    if (EXTRA_WINANSI.has(ch)) { bytes.push(EXTRA_WINANSI.get(ch)); continue; }
    // Do not corrupt emoji/non-Latin notes or omit personal information:
    // PDF must fail honestly, suggesting full Unicode XLSX instead.
    throw new Error('El PDF contiene caracteres no admitidos por Helvetica. Descargá XLSX o CSV para conservar el texto íntegro.');
  }
  return Buffer.from(bytes);
}
function pdfLiteral(value) {
  const bytes = encodePdfWinAnsi(value);
  const output = [];
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) output.push(0x5c);
    output.push(byte);
  }
  return Buffer.from(output).toString('latin1');
}
function wrapped(text, max = 92) {
  // Preserve every character, rather than silently shortening long notes.
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
    .flatMap(line => {
      if (!line) return [''];
      const chunks = [];
      while (line.length > max) {
        let end = line.lastIndexOf(' ', max);
        if (end < max / 2) end = max;
        chunks.push(line.slice(0, end));
        line = line.slice(end).replace(/^ +/, '');
      }
      chunks.push(line);
      return chunks;
    });
}
function contentLines(snapshot) {
  const { field, observations, workOrders, period } = snapshot;
  const lines = [
    'SEDEAGRO | REPORTE DE LOTE',
    'Lote: ' + (field.name || '-') + ' | Establecimiento: ' + (field.Farm?.name || '-'),
    'ID: ' + field.id + ' | Hectareas: ' + (field.area_hectares ?? '-'),
    'Periodo UTC: ' + (period.from || 'inicio') + ' a ' + (period.to || 'actualidad'),
    'Observaciones: ' + observations.length + ' | Ordenes: ' + workOrders.length,
    '------------------------------------------------------------',
    'OBSERVACIONES'
  ];
  for (const item of observations) {
    lines.push('ID: ' + item.id + ' | ' + new Date(item.observed_at).toISOString());
    lines.push('Tipo: ' + item.observation_type + ' | Severidad: ' + item.severity);
    lines.push(...wrapped('Detalle: ' + (item.notes || '(sin detalle)')));
    lines.push('');
  }
  lines.push('------------------------------------------------------------', 'ORDENES DE TRABAJO');
  for (const item of workOrders) {
    lines.push('ID: ' + item.id + ' | ' + new Date(item.created_at).toISOString());
    lines.push('Tipo: ' + item.type + ' | Estado: ' + item.status + ' | Prioridad: ' + item.priority);
    lines.push(...wrapped('Titulo: ' + item.title));
    lines.push('');
  }
  return lines.flatMap(line => wrapped(line));
}
export function buildFieldPdf(snapshot) {
  const lines = contentLines(snapshot);
  const pages = [];
  for (let offset = 0; offset < lines.length; offset += LINES_PER_PAGE) {
    pages.push(lines.slice(offset, offset + LINES_PER_PAGE));
    if (pages.length > MAX_PAGES) {
      throw new Error('El PDF supera el máximo de páginas permitido. Elegí un período más corto.');
    }
  }
  if (!pages.length) throw new Error('No hay contenido para el PDF.');
  const obj = [null, '<< /Type /Catalog /Pages 2 0 R >>', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const references = [];
  for (let page = 0; page < pages.length; page++) {
    const pageId = 4 + page * 2, streamId = pageId + 1;
    references.push(pageId + ' 0 R');
    const pageLines = pages[page].concat(['Pagina ' + (page + 1) + ' / ' + pages.length]);
    const commands = ['BT', '/F1 9 Tf', `1 0 0 1 ${LEFT} ${TOP} Tm`];
    for (const line of pageLines) {
      commands.push('(' + pdfLiteral(line) + ') Tj', `0 -${LINE_HEIGHT} Td`);
    }
    commands.push('ET');
    const stream = Buffer.from(commands.join('\n') + '\n', 'latin1');
    obj[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`;
    obj[streamId] = Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream,
      Buffer.from('endstream', 'latin1')
    ]);
  }
  obj[2] = `<< /Type /Pages /Kids [${references.join(' ')}] /Count ${pages.length} >>`;
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [0];
  let byteOffset = chunks[0].length;
  for (let i = 1; i < obj.length; i++) {
    offsets[i] = byteOffset;
    const prefix = Buffer.from(`${i} 0 obj\n`, 'ascii');
    const body = Buffer.isBuffer(obj[i]) ? obj[i] : Buffer.from(obj[i], 'latin1');
    const suffix = Buffer.from('\nendobj\n', 'ascii');
    chunks.push(prefix, body, suffix);
    byteOffset += prefix.length + body.length + suffix.length;
  }
  const crossRef = [
    'xref', `0 ${obj.length}`, '0000000000 65535 f ',
    ...offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n '),
    'trailer', `<< /Size ${obj.length} /Root 1 0 R >>`,
    'startxref', String(byteOffset), '%%EOF', ''
  ].join('\n');
  chunks.push(Buffer.from(crossRef, 'ascii'));
  const pdf = Buffer.concat(chunks);
  if (pdf.length > MAX_PDF_BYTES) {
    throw new Error('El PDF supera 3 MiB. Elegí un período más corto.');
  }
  return pdf;
}
