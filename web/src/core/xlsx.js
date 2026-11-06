// xlsx 讀取（自行實作，不依賴外部函式庫）：工作表清單、共用字串、日期格式、逐列串流讀取。
// 儲存格一律回傳原始文字（數值保留 Excel 存的文字，不經浮點轉換），另附型別：
//   s＝文字、n＝數值、d＝日期格式之數值（附 iso）、b＝布林、e＝錯誤、f＝公式文字結果。
import { SpecError } from './errors.js';
import { readZip } from './zip.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function xmlUnescape(s) {
  if (s.indexOf('&') < 0 && s.indexOf('_x') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e];
  }).replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? xmlUnescape(m[1]) : null;
}

// 文字節點：<t>…</t>（含rich text <r><t>）；排除注音 <rPh>
function textOf(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(clean))) out += m[1] ? xmlUnescape(m[1]) : '';
  return out;
}

export function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(code) {
  const s = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(s) && !/^[#0.,%\s]*$/.test(s);
}

function parseStyles(xml) {
  if (!xml) return new Set();
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode') || '';
    custom.set(id, code);
  }
  const dateStyles = new Set();
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!xfs) return dateStyles;
  let i = 0;
  for (const m of xfs[1].matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId') || 0);
    if (BUILTIN_DATE.has(id) || (custom.has(id) && isDateFormat(custom.get(id)))) dateStyles.add(i);
    i++;
  }
  return dateStyles;
}

// Excel 日期序號→YYYY-MM-DD（1900系統：以1899-12-30為0；1904系統另計）
export function serialToIso(text, date1904) {
  const v = Number(text);
  if (!Number.isFinite(v)) return null;
  const days = Math.floor(v) + (date1904 ? 1462 : 0);
  const ms = Date.UTC(1899, 11, 30) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function resolveTarget(target) {
  if (target.startsWith('/')) return target.slice(1);
  return 'xl/' + target.replace(/^\.\//, '');
}

export function openXlsx(bytes) {
  let zip;
  try {
    zip = readZip(bytes);
  } catch (e) {
    throw new SpecError('XLSX', '無法讀取xlsx（' + e.message + '）；若為舊版.xls請另存為.xlsx或CSV UTF-8');
  }
  const wbXml = zip.text('xl/workbook.xml');
  if (!wbXml) throw new SpecError('XLSX', '不是xlsx檔（缺 xl/workbook.xml）');
  const relsXml = zip.text('xl/_rels/workbook.xml.rels') || '';
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) rels.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const rid = attr(m[0], 'r:id') || attr(m[0], 'id');
    const target = rels.get(rid);
    if (target) sheets.push({ name: attr(m[0], 'name'), path: resolveTarget(target), state: attr(m[0], 'state') || 'visible' });
  }
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wbXml);
  let shared = null;
  let dateStyles = null;
  const loadShared = () => {
    if (shared) return shared;
    shared = [];
    if (!zip.has('xl/sharedStrings.xml')) return shared;
    // 逐段解析 <si>，避免整檔一次轉字串
    const dec = new TextDecoder('utf-8');
    let buf = '';
    for (const chunk of zip.chunks('xl/sharedStrings.xml')) {
      buf += dec.decode(chunk, { stream: true });
      let end = buf.lastIndexOf('</si>');
      if (end < 0) continue;
      end += 5;
      const part = buf.slice(0, end);
      buf = buf.slice(end);
      for (const m of part.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');
    }
    buf += dec.decode();
    for (const m of buf.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');
    return shared;
  };
  const styles = () => {
    if (!dateStyles) dateStyles = parseStyles(zip.text('xl/styles.xml'));
    return dateStyles;
  };
  return {
    sheets: sheets.map((s) => s.name),
    // 逐列產生 {rowNo, cells: Map(col → {v, t, iso?})}；wanted(col)：只解析需要的欄（加速）
    *rows(sheetName, { wanted } = {}) {
      const sh = sheets.find((s) => s.name === sheetName) || (sheetName ? null : sheets[0]);
      if (!sh) throw new SpecError('XLSX', `找不到工作表：${sheetName}`);
      const sst = loadShared();
      const ds = styles();
      const dec = new TextDecoder('utf-8');
      let buf = '';
      let nextRow = 1;
      const parseRow = (attrs, inner) => {
        const r = attr(attrs, 'r');
        const rowNo = r ? Number(r) : nextRow;
        nextRow = rowNo + 1;
        const cells = new Map();
        let nextCol = 0;
        if (inner) {
          const cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
          let m;
          while ((m = cre.exec(inner))) {
            const a = m[1];
            const ref = attr(a, 'r');
            const col = ref ? colIndex(ref) : nextCol;
            nextCol = col + 1;
            if (wanted && !wanted(col)) continue;
            const body = m[2] || '';
            const t = attr(a, 't') || 'n';
            let v = null;
            let type = t;
            if (t === 'inlineStr') { v = textOf(body); type = 's'; } else {
              const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
              if (!vm) continue;
              v = xmlUnescape(vm[1]);
              if (t === 's') { v = sst[Number(v)]; if (v === undefined) throw new SpecError('XLSX', `共用字串索引錯誤（第${rowNo}列）`); type = 's'; }
              else if (t === 'str') type = 'f';
              else if (t === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
            }
            const cell = { v, t: type };
            if (type === 'n') {
              const s = attr(a, 's');
              if (s !== null && ds.has(Number(s))) { cell.t = 'd'; cell.iso = serialToIso(v, date1904); }
            }
            cells.set(col, cell);
          }
        }
        return { rowNo, cells };
      };
      const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
      for (const chunk of zip.chunks(sh.path)) {
        buf += dec.decode(chunk, { stream: true });
        let end = buf.lastIndexOf('</row>');
        if (end < 0) continue;
        end += 6;
        const part = buf.slice(0, end);
        buf = buf.slice(end);
        rowRe.lastIndex = 0;
        let m;
        while ((m = rowRe.exec(part))) yield parseRow(m[1], m[2]);
      }
      buf += dec.decode();
      rowRe.lastIndex = 0;
      let m;
      while ((m = rowRe.exec(buf))) yield parseRow(m[1], m[2]);
    },
  };
}
