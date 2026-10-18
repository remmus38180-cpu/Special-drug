// 瀏覽器端整合測試（開發環境 Playwright＋Chromium）。資料夾以瀏覽器私有檔案系統（OPFS）模擬，
// 因 file:// 下 OPFS 不可用，以本機 http 伺服器提供建置後之單檔HTML。
// 執行：node test/e2e/run.mjs（需已 node build.mjs；PLAYWRIGHT 模組路徑可由 PW 環境變數指定）
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../dist');
const htmlName = readdirSync(dist).find((n) => n.endsWith('.html'));
const html = readFileSync(resolve(dist, htmlName));

let pwPath = process.env.PW;
if (!pwPath) {
  try { pwPath = resolve(execSync('npm root -g').toString().trim(), 'playwright'); } catch (e) { pwPath = 'playwright'; }
}
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)(pwPath));
} catch (e) {
  console.log('略過：找不到 Playwright（' + pwPath + '）');
  process.exit(0);
}

const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/app.html`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(window.localStorage.getItem('e2e.dir') || 'f1', { create: true });
  };
});
const external = [];
const consoleErrors = [];
ctx.on('request', (r) => { if (!r.url().startsWith(url.replace('/app.html', '')) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });

async function newPage() {
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', (e) => consoleErrors.push(String(e)));
  await p.goto(url);
  return p;
}

const dlgText = (p) => p.locator('dialog.dlg').last().innerText();
const clickDlg = (p, label) => p.locator('dialog.dlg').last().getByRole('button', { name: label, exact: true }).click();

try {
  const p1 = await newPage();
  check('啟動畫面與自檢', (await p1.locator('h2', { hasText: '啟動自檢' }).count()) === 1);
  check('title 含版本', (await p1.title()).includes('0.4.0'));
  await p1.getByLabel('員編／姓名').fill('A001王小明');
  await p1.getByLabel('電腦代號').fill('PC-01');
  await p1.getByRole('button', { name: '儲存使用者' }).click();
  await p1.getByRole('button', { name: '建立新資料夾（選空資料夾）' }).click();
  const pw = p1.locator('dialog.dlg input[type=password]');
  await pw.nth(0).fill('kw-1234');
  await pw.nth(1).fill('kw-1234');
  await clickDlg(p1, '確定');
  await p1.locator('.statusbar', { hasText: 'r000000' }).waitFor({ timeout: 10000 });
  check('建立新資料夾→查詢模式 r000000', (await p1.locator('.statusbar').innerText()).includes('模式：查詢'));
  await p1.getByRole('button', { name: '開始編輯' }).click();
  await p1.locator('.statusbar', { hasText: '模式：編輯中' }).waitFor({ timeout: 15000 });
  check('開始編輯（取牌，等候3秒確認）', true);
  await p1.getByRole('button', { name: '設定', exact: true }).click();
  const hb = p1.locator('table input[type=number]').first();
  await hb.fill('45');
  await p1.getByRole('button', { name: '套用設定（成為未儲存變更）' }).click();
  await p1.locator('.statusbar', { hasText: '未儲存變更：1' }).waitFor();
  check('修改設定→未儲存變更 1', true);
  await p1.getByRole('button', { name: '儲存', exact: true }).click();
  await p1.locator('.statusbar', { hasText: 'r000001' }).waitFor({ timeout: 10000 });
  check('儲存→r000001', (await p1.locator('.statusbar').innerText()).includes('未儲存變更：0'));

  // 第二分頁：H04
  const p2 = await newPage();
  await p2.getByRole('button', { name: '重新授權上次資料夾' }).click();
  await p2.locator('.statusbar', { hasText: 'r000001' }).waitFor({ timeout: 10000 });
  check('第二分頁以記住之資料夾開啟（IndexedDB 授權記憶）', true);
  await p2.getByRole('button', { name: '開始編輯' }).click();
  await p2.locator('dialog.dlg').waitFor();
  const t2 = await dlgText(p2);
  check('H04 第二分頁不可編輯並說明原因', t2.includes('另一分頁'), t2.replace(/\s+/g, ' ').slice(0, 80));
  await clickDlg(p2, '確定');

  // 有未儲存變更時離開提醒＋當機復原草稿
  await p1.getByRole('button', { name: '設定', exact: true }).click();
  await p1.locator('table input[type=number]').first().fill('50');
  await p1.getByRole('button', { name: '套用設定（成為未儲存變更）' }).click();
  await p1.locator('.statusbar', { hasText: '未儲存變更：1' }).waitFor();
  await p1.close({ runBeforeUnload: false });
  await p2.close();
  const p3 = await newPage();
  await p3.getByRole('button', { name: '重新授權上次資料夾' }).click();
  await p3.locator('dialog.dlg').waitFor({ timeout: 10000 });
  const t3 = await dlgText(p3);
  check('H07 重開提示復原草稿', t3.includes('復原草稿'), t3.replace(/\s+/g, ' ').slice(0, 60));
  // 前一分頁關閉時已嘗試還牌 → 可立即取牌復原
  await clickDlg(p3, '取得編輯牌並復原');
  // H19（來不及還牌）：關閉分頁時還牌不保證完成；他人（含同瀏覽器新分頁）於逾時前被擋
  await p3.locator('dialog.dlg', { hasText: '編輯牌在他人手上' }).waitFor({ timeout: 15000 });
  const t3b = await dlgText(p3);
  check('H19 來不及還牌：逾時前被擋，提示持牌者、取牌時間、最後回應', t3b.includes('A001王小明') && t3b.includes('最後回應'), t3b.replace(/\s+/g, ' ').slice(0, 70));
  // H27／H26：錯誤關鍵詞不收回；正確關鍵詞＋原因收回
  await clickDlg(p3, '強制收回');
  let fd = p3.locator('dialog.dlg').last();
  await fd.locator('input[type=password]').fill('wrong');
  await fd.locator('input[type=text]').fill('前一分頁已當機');
  await clickDlg(p3, '強制收回');
  await p3.locator('dialog.dlg', { hasText: '關鍵詞不正確' }).waitFor();
  check('H27 錯誤關鍵詞不收回', true);
  await clickDlg(p3, '確定');
  await p3.getByRole('button', { name: '強制收回' }).click();
  fd = p3.locator('dialog.dlg').last();
  await fd.locator('input[type=password]').fill('kw-1234');
  await fd.locator('input[type=text]').fill('前一分頁已當機');
  await clickDlg(p3, '強制收回');
  await p3.locator('dialog.dlg', { hasText: '已收回' }).waitFor({ timeout: 15000 });
  await clickDlg(p3, '確定');
  await p3.locator('dialog.dlg', { hasText: '復原草稿' }).waitFor({ timeout: 10000 });
  await clickDlg(p3, '復原');
  await p3.locator('.statusbar', { hasText: '未儲存變更：1' }).waitFor({ timeout: 15000 });
  check('H26 正確關鍵詞強制收回→編輯中；草稿復原', (await p3.locator('.statusbar').innerText()).includes('編輯中'));
  await p3.getByRole('button', { name: '儲存', exact: true }).click();
  await p3.locator('.statusbar', { hasText: 'r000002' }).waitFor({ timeout: 10000 });
  await p3.getByRole('button', { name: '儲存歷程' }).click();
  await p3.getByRole('button', { name: '檢查全部版本檔' }).click();
  await p3.locator('td', { hasText: '目前版本' }).waitFor();
  const rows = await p3.locator('.panel table').first().locator('tbody tr').count();
  const okCount = await p3.locator('td', { hasText: '✔ 一致' }).count();
  check('儲存歷程 3 個版本雜湊一致', rows === 3 && okCount === 3, `${rows} 列、${okCount} 一致`);
  check('稽核含強制收回紀錄', (await p3.locator('td', { hasText: '強制收回編輯牌' }).count()) >= 1);
  await p3.getByRole('button', { name: '結束編輯' }).click();
  await p3.locator('.statusbar', { hasText: '編輯牌：無人持有' }).waitFor({ timeout: 10000 });
  check('H18 結束編輯→編輯牌無人持有', true);

  // 非空、非本系統資料夾拒絕初始化
  await p3.getByRole('button', { name: '關閉資料夾' }).click();
  await p3.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('other', { create: true });
    const f = await d.getFileHandle('x.txt', { create: true });
    const w = await f.createWritable(); await w.write('x'); await w.close();
    window.localStorage.setItem('e2e.dir', 'other');
  });
  await p3.getByRole('button', { name: '建立新資料夾（選空資料夾）' }).click();
  await p3.locator('dialog.dlg').waitFor();
  check('非空資料夾拒絕建立', (await dlgText(p3)).includes('不是本系統資料夾'));
  await clickDlg(p3, '確定');

  check('H02 參考：無外部請求', external.length === 0, external.join(', '));
  check('無主控台錯誤', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  check('執行中斷', false, String(e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
