// xlsx 寫入（自行實作，stored zip）。儲存格：字串、{n:'12.5'}數值文字、{date:'YYYY-MM-DD'}日期。
// 文字一律以 inlineStr 寫入，不被Excel當公式；匯出時另於呼叫端防公式注入。
import { writeZip } from './zip.js';
import { colName } from './xlsx.js';

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    // XML 1.0 不允許之控制字元
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`);
}

function serial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
}

function sheetXml(rows) {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  rows.forEach((row, ri) => {
    const r = ri + 1;
    out.push(`<row r="${r}">`);
    row.forEach((v, ci) => {
      if (v === null || v === undefined || v === '') return;
      const ref = colName(ci) + r;
      if (typeof v === 'object' && v.n !== undefined) out.push(`<c r="${ref}"><v>${esc(v.n)}</v></c>`);
      else if (typeof v === 'object' && v.date) out.push(`<c r="${ref}" s="1"><v>${serial(v.date)}</v></c>`);
      else out.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`);
    });
    out.push('</row>');
  });
  out.push('</sheetData></worksheet>');
  return out.join('');
}

// sheets：[{name, rows}]；props：{title, author, created(ISO), subject, custom:{名:值}}
export function writeXlsx(sheets, props = {}) {
  const ns = 'http://schemas.openxmlformats.org';
  const files = [];
  const ct = [`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${ns}/package/2006/content-types">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>'];
  sheets.forEach((s, i) => ct.push(`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`));
  ct.push('</Types>');
  files.push({ name: '[Content_Types].xml', data: ct.join('') });
  files.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="${ns}/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${ns}/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>` });
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${ns}/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${ns}/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Microsoft JhengHei"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>` });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) }));
  const created = props.created || new Date(0).toISOString();
  files.push({ name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="${ns}/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(props.title || '')}</dc:title><dc:subject>${esc(props.subject || '')}</dc:subject><dc:creator>${esc(props.author || '')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${esc(created.replace(/\.\d+Z$/, 'Z'))}</dcterms:created></cp:coreProperties>` });
  const custom = Object.entries(props.custom || {}).map(([k, v], i) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="${esc(k)}"><vt:lpwstr>${esc(v)}</vt:lpwstr></property>`).join('');
  files.push({ name: 'docProps/custom.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="${ns}/officeDocument/2006/custom-properties" xmlns:vt="${ns}/officeDocument/2006/docPropsVTypes">${custom}</Properties>` });
  return writeZip(files);
}
