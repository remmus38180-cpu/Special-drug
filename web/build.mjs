// 建置：把 src/ 之ES模組合併為單一離線HTML（web/dist/特殊藥品管理_v<版本>.html）。
// 只在開發環境使用；使用者端不需要。不下載任何東西。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, 'src');
const ENTRY = resolve(SRC, 'ui/main.js');

const IMPORT_RE = /^import\s+\{([^}]*)\}\s+from\s+'(\.[^']+)';\s*$/gm;
const EXPORT_RE = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

function modName(file) {
  return '__m_' + relative(SRC, file).replace(/[^A-Za-z0-9]/g, '_');
}

const order = [];
const seen = new Set();
function visit(file, stack = []) {
  if (seen.has(file)) return;
  if (stack.includes(file)) throw new Error('循環引用：' + stack.concat(file).join(' -> '));
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) visit(resolve(dirname(file), m[2]), stack.concat(file));
  seen.add(file);
  order.push(file);
}
visit(ENTRY);

function transform(file) {
  let src = readFileSync(file, 'utf8');
  if (/^\s*import\s/m.test(src.replace(IMPORT_RE, ''))) throw new Error('不支援的import語法：' + file);
  if (/^export\s+(default|\{|\*)/m.test(src)) throw new Error('不支援的export語法：' + file);
  const exportsList = [...src.matchAll(EXPORT_RE)].map((m) => m[1]);
  src = src.replace(IMPORT_RE, (all, names, from) => {
    const target = modName(resolve(dirname(file), from));
    const parts = names.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/\s+as\s+/, ': '));
    return `const { ${parts.join(', ')} } = ${target};`;
  });
  src = src.replace(/^export\s+/gm, '');
  return `// ---- ${relative(SRC, file)} ----\nconst ${modName(file)} = (function () {\n${src}\nreturn { ${exportsList.join(', ')} };\n})();\n`;
}

let commit = 'unknown';
try { commit = execSync('git rev-parse --short=7 HEAD', { cwd: here }).toString().trim(); } catch (e) { /* 非git環境 */ }
try { if (execSync('git status --porcelain -- src build.mjs', { cwd: here }).toString().trim()) commit += '+dirty'; } catch (e) { /* 忽略 */ }
const now = new Date(Date.now() + 8 * 3600 * 1000);
const buildDate = now.toISOString().slice(0, 10);

const version = /APP_VERSION = '([^']+)'/.exec(readFileSync(resolve(SRC, 'core/version.js'), 'utf8'))[1];
const schema = /SCHEMA_VERSION = (\d+)/.exec(readFileSync(resolve(SRC, 'core/version.js'), 'utf8'))[1];

let js = '"use strict";\n' + order.map(transform).join('\n');
js = js.replace(/'__BUILD_DATE__'/g, JSON.stringify(buildDate)).replace(/'__COMMIT__'/g, JSON.stringify(commit));
const css = readFileSync(resolve(SRC, 'ui/styles.css'), 'utf8');
if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error('原始碼含 </script 或 </style，無法內嵌');

let html = readFileSync(resolve(SRC, 'index.html'), 'utf8');
html = html.split('__APP_VERSION__').join(version).split('__SCHEMA_VERSION__').join(schema)
  .split('__BUILD_DATE__').join(buildDate).split('__COMMIT__').join(commit);
html = html.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);

// 第4.2節：禁用語法與外部資源檢查（建置即擋）
const FORBIDDEN = [
  [/\beval\s*\(/, 'eval('], [/new\s+Function\b/, 'new Function'], [/document\.write/, 'document.write'],
  [/set(?:Timeout|Interval)\s*\(\s*['"`]/, '字串型 setTimeout／setInterval'], [/WebAssembly/, 'WebAssembly'],
  [/<script[^>]+src\s*=/i, '外部 script'], [/<link[^>]+href\s*=/i, '外部 link'], [/@import/, 'CSS @import'],
  [/<iframe/i, 'iframe'], [/importScripts\s*\(/, 'importScripts'], [/\bfetch\s*\(/, 'fetch('], [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/window\.open\s*\(/, 'window.open'], [/https?:\/\//, '網址'],
];
const problems = FORBIDDEN.filter(([re]) => re.test(html)).map(([, label]) => label);
if (problems.length) throw new Error('建置輸出含禁用內容：' + problems.join('、'));

const outDir = resolve(here, 'dist');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `特殊藥品管理_v${version}.html`);
writeFileSync(out, html);
console.log(`已建置 ${relative(here, out)}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB，commit ${commit}，模組 ${order.length} 個）`);
