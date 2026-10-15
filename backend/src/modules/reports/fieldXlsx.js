// Minimal, self-contained OOXML XLSX, with inline UTF-8 strings ONLY.
// No formulas, macros, shared external links, XML entities or remote targets.
import { fieldReportRows } from './fieldCsv.js';
const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;

function xmlSafe(value) {
  // XML 1.0 disallows NUL, C0 (except tab, lf, cr), surrogate fragments.
  return Array.from(String(value ?? '')).filter(ch => {
    const cp = ch.codePointAt(0);
    return !((cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) ||
      (cp >= 0xd800 && cp <= 0xdfff));
  }).join('')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colName(index) {
  let n = index + 1, result = '';
  while (n > 0) { n -= 1; result = String.fromCharCode(65 + n % 26) + result; n = Math.floor(n / 26); }
  return result;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStored(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, payload] of entries) {
    const filename = Buffer.from(name, 'utf8');
    const body = Buffer.from(payload, 'utf8');
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(body.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    chunks.push(local, filename, body);
    central.push(directory, filename);
    offset += local.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...chunks, directory, end]);
  if (zip.length > MAX_DOCUMENT_BYTES) {
    throw new Error('El archivo XLSX supera 3 MiB. Elegí un período más corto.');
  }
  return zip;
}

export function buildFieldXlsx(snapshot) {
  const rows = fieldReportRows(snapshot);
  const lines = rows.map((row, ri) => {
    const cells = row.map((cell, ci) => {
      // inlineStr means text even when a user note starts with =,+,-,@.
      // Excell/LibreOffice cannot evaluate it as a formula.
      const ref = colName(ci) + (ri + 1);
      return `<c r="${ref}" t="inlineStr" s="${ri === 0 ? 1 : 0}"><is><t xml:space="preserve">${xmlSafe(cell)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="3" width="39" customWidth="1"/>
<col min="4" max="5" width="27" customWidth="1"/><col min="6" max="8" width="21" customWidth="1"/>
<col min="9" max="9" width="64" customWidth="1"/></cols>
<sheetData>${lines.join('')}</sheetData><autoFilter ref="A1:I${rows.length}"/>
</worksheet>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Reporte por lote" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Aptos"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF176348"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1"/></cellXfs>
</styleSheet>`;
  return zipStored([
    ['[Content_Types].xml', types], ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbook], ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/styles.xml', styles], ['xl/worksheets/sheet1.xml', sheet]
  ]);
}
