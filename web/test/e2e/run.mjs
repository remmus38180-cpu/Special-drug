// 瀏覽器端整合測試（開發環境 Playwright＋Chromium）。資料夾以瀏覽器私有檔案系統（OPFS）模擬，
// 因 file:// 下 OPFS 不可用，以本機 http 伺服器提供建置後之單檔HTML。
// 執行：node test/e2e/run.mjs（需已 node build.mjs；PLAYWRIGHT 模組路徑可由 PW 環境變數指定）
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
  // 另存對話框：寫入 OPFS exports/，記錄檔名
  window.showSaveFilePicker = async ({ suggestedName }) => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('exports', { create: true });
    window.__saved = (window.__saved || []).concat([suggestedName]);
    // headless Chromium 之 OPFS 不接受中文檔名：以編碼後名稱存放（僅測試替身）
    return d.getFileHandle('f' + window.__saved.length, { create: true });
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
  // H19（同瀏覽器）：前一分頁關閉、還牌未完成 → 分頁鎖已釋放，視同已還牌（LOCAL_CLOSED_RELEASE）
  await clickDlg(p3, '取得編輯牌並復原');
  // 關閉分頁時還牌不保證完成：來得及→直接取牌；來不及→以分頁鎖判定前一分頁已關閉並提示
  const took = await Promise.race([
    p3.locator('dialog.dlg', { hasText: '先前的分頁' }).waitFor({ timeout: 15000 }).then(() => 'local'),
    p3.locator('.statusbar', { hasText: '未儲存變更：1' }).waitFor({ timeout: 15000 }).then(() => 'released'),
  ]);
  check('H19 同瀏覽器前一分頁已關閉：立即取牌（' + (took === 'local' ? '還牌未完成，依分頁鎖判定' : '關閉時已還牌') + '）', true);
  if (took === 'local') await clickDlg(p3, '確定');
  await p3.locator('.statusbar', { hasText: '未儲存變更：1' }).waitFor({ timeout: 15000 });
  check('H07 草稿復原', (await p3.locator('.statusbar').innerText()).includes('編輯中'));
  await p3.getByRole('button', { name: '儲存', exact: true }).click();
  await p3.locator('.statusbar', { hasText: 'r000002' }).waitFor({ timeout: 10000 });
  await p3.getByRole('button', { name: '結束編輯' }).click();
  await p3.locator('.statusbar', { hasText: '編輯牌：無人持有' }).waitFor({ timeout: 10000 });
  check('H18 結束編輯→編輯牌無人持有', true);
  // H17：模擬另一台電腦持牌（寫入編輯牌檔）
  await p3.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const d = await (await root.getDirectoryHandle('f1')).getDirectoryHandle('control');
    const f = await d.getFileHandle('editing.json');
    const now = new Date().toISOString();
    const w = await f.createWritable();
    await w.write(JSON.stringify({ format: 'specdrug-editing', state: 'held', holder: { user: 'B002李小華', pc: 'PC-02' }, session_id: 'other-pc-session', acquired_at: now, heartbeat_seq: 1, heartbeat_at: now, base_revision: 2 }));
    await w.close();
  });
  await p3.getByRole('button', { name: '開始編輯' }).click();
  await p3.locator('dialog.dlg', { hasText: '編輯牌在他人手上' }).waitFor({ timeout: 15000 });
  const t3b = await dlgText(p3);
  check('H17 他人持牌：提示持牌者、電腦、取牌時間、最後回應', t3b.includes('B002李小華') && t3b.includes('PC-02') && t3b.includes('最後回應'), t3b.replace(/\s+/g, ' ').slice(0, 70));
  // H27／H26：錯誤關鍵詞不收回；正確關鍵詞＋原因收回
  await clickDlg(p3, '強制收回');
  let fd = p3.locator('dialog.dlg').last();
  await fd.locator('input[type=password]').fill('wrong');
  await fd.locator('input[type=text]').fill('對方請假');
  await clickDlg(p3, '強制收回');
  await p3.locator('dialog.dlg', { hasText: '關鍵詞不正確' }).waitFor();
  check('H27 錯誤關鍵詞不收回', true);
  await clickDlg(p3, '確定');
  await p3.getByRole('button', { name: '強制收回' }).click();
  fd = p3.locator('dialog.dlg').last();
  await fd.locator('input[type=password]').fill('kw-1234');
  await fd.locator('input[type=text]').fill('對方請假');
  await clickDlg(p3, '強制收回');
  await p3.locator('dialog.dlg', { hasText: '已收回' }).waitFor({ timeout: 15000 });
  await clickDlg(p3, '確定');
  await p3.locator('.statusbar', { hasText: '模式：編輯中' }).waitFor({ timeout: 15000 });
  check('H26 正確關鍵詞強制收回→編輯中', true);
  await p3.getByRole('button', { name: '結束編輯' }).click();
  await p3.locator('.statusbar', { hasText: 'r000003' }).waitFor({ timeout: 10000 });
  check('強制收回稽核於結束編輯時自動寫入新版本', true);
  await p3.getByRole('button', { name: '儲存歷程' }).click();
  await p3.getByRole('button', { name: '檢查全部版本檔' }).click();
  await p3.locator('td', { hasText: '目前版本' }).waitFor();
  const rows = await p3.locator('.panel table').first().locator('tbody tr').count();
  const okCount = await p3.locator('td', { hasText: '✔ 一致' }).count();
  check('儲存歷程 4 個版本雜湊一致', rows === 4 && okCount === 4, `${rows} 列、${okCount} 一致`);
  check('稽核含強制收回紀錄', (await p3.locator('td', { hasText: '強制收回編輯牌' }).count()) >= 1);

  // 模擬資料：新資料夾載入
  await p3.getByRole('button', { name: '關閉資料夾' }).click();
  await p3.evaluate(() => window.localStorage.setItem('e2e.dir', 'demo'));
  await p3.getByRole('button', { name: '建立新資料夾（選空資料夾）' }).click();
  const pw2 = p3.locator('dialog.dlg input[type=password]');
  await pw2.nth(0).fill('kw-5678');
  await pw2.nth(1).fill('kw-5678');
  await clickDlg(p3, '確定');
  await p3.locator('.statusbar', { hasText: 'r000000' }).waitFor({ timeout: 10000 });
  await p3.getByRole('button', { name: '開始編輯' }).click();
  await p3.locator('.statusbar', { hasText: '模式：編輯中' }).waitFor({ timeout: 15000 });
  await p3.getByRole('button', { name: '載入示範資料到新資料夾' }).click();
  await clickDlg(p3, '載入');
  await p3.locator('dialog.dlg', { hasText: '已載入' }).waitFor({ timeout: 10000 });
  await clickDlg(p3, '確定');
  await p3.getByRole('button', { name: '儲存', exact: true }).click();
  await p3.locator('.statusbar', { hasText: 'r000001' }).waitFor({ timeout: 10000 });
  check('載入示範資料並儲存；狀態列標示示範資料夾', (await p3.locator('.statusbar').innerText()).includes('示範資料夾'));
  check('示範資料筆數', (await p3.locator('td', { hasText: 'case_record' }).locator('xpath=following-sibling::td').innerText()) === '3');

  // 階段3：案件、會議（T33：未通過案件與兩種會議，經介面操作）
  await p3.getByRole('button', { name: '案件', exact: true }).click();
  check('案件清單列出示範3案', (await p3.locator('section.panel table tbody tr').count()) === 3);
  await p3.locator('tr', { hasText: 'DEMO2026-0001' }).click();
  const tlText = await p3.locator('.timeline').innerText();
  check('案件詳情時間序列：專家建議與會議決議分別標示', tlText.indexOf('專家建議') >= 0 && tlText.indexOf('會議決議') > tlText.indexOf('專家建議'));
  await p3.getByRole('button', { name: '← 回案件清單' }).click();
  await p3.getByRole('button', { name: '新增案件' }).click();
  let fdlg = p3.locator('dialog.dlg').last();
  await fdlg.locator('.form-row', { hasText: '主旨' }).locator('input').fill('介面測試未通過案');
  await fdlg.locator('.form-row', { hasText: '申請廠商' }).locator('input').fill('測試藥廠');
  await fdlg.locator('.form-row', { hasText: '收文日' }).locator('input').fill('115/09/01');
  await fdlg.locator('.form-row', { hasText: '品項' }).locator('textarea').fill('0X00000001, X00000002');
  await clickDlg(p3, '建立');
  await p3.locator('h2', { hasText: '介面測試未通過案' }).waitFor();
  check('新增案件→自動案號、民國日期轉換、待確認標示', (await p3.locator('section.panel').first().innerText()).includes('2026-09-01') && (await p3.locator('.warn-text', { hasText: '待確認' }).count()) >= 1);
  await p3.getByRole('button', { name: '新增議案（選會議）' }).click();
  fdlg = p3.locator('dialog.dlg').last();
  await fdlg.locator('select').selectOption({ label: '2026-06-18｜共同擬訂｜模擬擬訂會議115年6月' });
  await clickDlg(p3, '下一步');
  await clickDlg(p3, '確定');
  await p3.getByRole('button', { name: '新增決議／建議' }).click();
  fdlg = p3.locator('dialog.dlg').last();
  await fdlg.locator('.form-row', { hasText: '結果性質' }).locator('select').selectOption('會議決議');
  await fdlg.locator('.form-row', { hasText: /^結果＊/ }).locator('select').selectOption('不同意');
  await fdlg.locator('.form-row', { hasText: '品項 0X00000001' }).locator('select').selectOption('不同意');
  await clickDlg(p3, '確定');
  await p3.locator('.timeline td', { hasText: '0X00000001' }).waitFor();
  check('同次會議共用、逐品項結果；未列入品項不推定', (await p3.locator('.timeline td', { hasText: 'X00000002' }).count()) === 0);
  await p3.getByRole('button', { name: '確認結果摘要' }).click();
  fdlg = p3.locator('dialog.dlg').last();
  await fdlg.locator('select').first().selectOption('全部不同意');
  await clickDlg(p3, '下一步');
  await p3.locator('dialog.dlg', { hasText: '請勾選至少一項決議' }).waitFor();
  check('結果摘要未連結依據時阻止', true);
  await fdlg.locator('input[type=checkbox]').first().check();
  await clickDlg(p3, '下一步');
  await clickDlg(p3, '確認');
  await p3.getByRole('button', { name: '結案／撤回' }).click();
  fdlg = p3.locator('dialog.dlg').last();
  await fdlg.locator('.form-row', { hasText: '原因' }).locator('textarea').fill('共擬不同意');
  await fdlg.locator('.form-row', { hasText: '依據' }).locator('textarea').fill('模擬擬訂會議紀錄');
  await clickDlg(p3, '下一步');
  await clickDlg(p3, '確認');
  await p3.locator('dd', { hasText: '已結案：共擬不同意' }).waitFor();
  check('確認摘要並結案', (await p3.locator('dd', { hasText: '全部不同意' }).count()) >= 1);
  await p3.getByRole('button', { name: '儲存', exact: true }).click();
  await p3.locator('.statusbar', { hasText: 'r000002' }).waitFor({ timeout: 10000 });
  await p3.getByRole('button', { name: '會議', exact: true }).click();
  await p3.locator('tr', { hasText: '模擬擬訂會議115年6月' }).click();
  check('會議詳情列出同次會議之3個議案', (await p3.locator('section.panel table tbody tr').count()) === 3);
  // 階段4：主檔匯入（CSV）
  await p3.getByRole('button', { name: '主檔', exact: true }).click();
  const csvText = '\ufeffCODE,藥品名稱,藥商名稱,分組代碼,ATC7碼,PDOSE,複方藥品,規格量,規格單位,price11511,必要藥品\r\n' +
    'A000001100,DRUG A1,甲,G1AAA0000001,J06BA01,20,N,5,ML,120,0\r\n0A00005100,DRUG Z,丙,G1BBB0000001,L04AA03,11,N,,,8.50,\r\nB000004100,DRUG C1,丁,G1CCC0000001,L04AA03,11,Y,1,VIAL,6,3\r\n';
  await p3.locator('input[type=file]').first().setInputFiles({ name: '測試主檔11511.csv', mimeType: 'text/csv', buffer: Buffer.from(csvText, 'utf8') });
  await p3.getByRole('button', { name: '讀取標題列' }).waitFor();
  await p3.getByRole('button', { name: '讀取標題列' }).click();
  await p3.getByLabel('資料基準日').fill('115/11/01');
  await p3.getByLabel('資料基準日').press('Tab');
  await p3.getByRole('button', { name: '試匯入（不改目前主檔）' }).click();
  await p3.locator('p', { hasText: '試匯入完成' }).waitFor({ timeout: 15000 });
  const chk = await p3.locator('section.panel', { hasText: '試匯入檢核結果' }).innerText();
  check('主檔試匯入：3代碼、預選price11511、未知單位VIAL', chk.includes('代碼數\t3') && chk.includes('VIAL'), chk.replace(/\s+/g, ' ').slice(0, 120));
  await p3.getByRole('button', { name: '確認並啟用此版本' }).click();
  await clickDlg(p3, '啟用');
  await p3.locator('p', { hasText: '已啟用' }).waitFor({ timeout: 15000 });
  await p3.getByRole('button', { name: '儲存', exact: true }).click();
  await p3.locator('.statusbar', { hasText: '主檔：測試主檔11511.csv（基準日 2026-11-01，3 筆）' }).waitFor({ timeout: 10000 });
  check('主檔啟用並儲存；狀態列顯示目前主檔版本', true);
  check('歷史版本：停用示範主檔', (await p3.locator('td', { hasText: '已停用' }).count()) === 1);
  // 階段5：規則點選與預覽
  await p3.getByRole('button', { name: '規則預覽', exact: true }).click();
  await p3.getByRole('button', { name: '載入主檔選項' }).click();
  await p3.getByRole('button', { name: '依分組加規格' }).click();
  await p3.getByLabel('搜尋分組代碼').fill('G1A');
  await p3.locator('.pick-item').first().click();
  await p3.getByLabel('規格數值').fill('5');
  await p3.getByLabel('規格數值').press('Tab');
  await p3.getByLabel('規格單位').selectOption('ML');
  const desc = await p3.locator('.rule-desc').innerText();
  check('規則點選：選項由主檔產生，說明文字正確', desc.includes('分組代碼 屬於 G1AAA0000001') && desc.includes('規格 = 5 ML') && desc.includes('條件格式正確'), desc.replace(/\s+/g, ' '));
  await p3.getByRole('button', { name: '預覽符合名單' }).click();
  await p3.locator('h2', { hasText: '範圍預覽' }).waitFor();
  const pvText = await p3.locator('section.panel', { hasText: '範圍預覽' }).innerText();
  check('預覽：符合1、名單含A000001100', /符合\t1/.test(pvText) && pvText.includes('A000001100'), pvText.replace(/\s+/g, ' ').slice(0, 100));
  await p3.getByRole('button', { name: '指定品項' }).click();
  await p3.getByLabel('貼上藥品代碼').fill('B000004100 NOPE0000');
  await p3.getByRole('button', { name: '加入', exact: true }).click();
  check('指定品項：主檔無此值標示', (await p3.locator('.chip-warn', { hasText: 'NOPE0000' }).count()) === 1);
  check('規則變更後須重新預覽', (await p3.locator('h2', { hasText: '範圍預覽' }).count()) === 0);
  // 階段6：認定項目、版本、條件、快照、確認
  await p3.getByRole('button', { name: '認定', exact: true }).click();
  await p3.getByRole('button', { name: '新增認定項目' }).click();
  await p3.locator('dialog.dlg').last().locator('.form-row', { hasText: '認定名稱' }).locator('input').fill('介面測試認定');
  await clickDlg(p3, '確定');
  await p3.getByRole('button', { name: '新增版本' }).click();
  let rd = p3.locator('dialog.dlg').last();
  const future = new Date(Date.now() + 8 * 3600e3 + 60 * 86400e3).toISOString().slice(0, 10);
  await rd.locator('.form-row', { hasText: '生效日' }).locator('input').fill(future);
  await clickDlg(p3, '確定');
  await p3.locator('h2', { hasText: '第 1 版（草稿）' }).waitFor();
  await p3.getByRole('button', { name: '編輯適用條件' }).click();
  await p3.getByRole('button', { name: '載入主檔選項' }).click();
  await p3.getByRole('button', { name: '依分組', exact: true }).click();
  await p3.getByLabel('搜尋分組代碼').fill('G1C');
  await p3.locator('.pick-item').first().click();
  await p3.getByRole('button', { name: '套用條件至此版本' }).click();
  await p3.getByRole('button', { name: /以目前主檔.*預覽/ }).click();
  await p3.getByRole('button', { name: '保存為快照（預覽狀態）' }).click();
  await p3.locator('h2', { hasText: '快照名單（預覽）' }).waitFor();
  check('建立快照：名單1筆', (await p3.locator('section.panel', { hasText: '快照名單（預覽）' }).innerText()).includes('最終範圍 1 筆'));
  await p3.getByRole('button', { name: '確認此快照名單' }).click();
  await clickDlg(p3, '確認');
  await p3.locator('h2', { hasText: '快照名單（已確認）' }).waitFor();
  await p3.getByRole('button', { name: '確認此認定版本' }).click();
  await clickDlg(p3, '確認');
  await p3.locator('h2', { hasText: '第 1 版（已確認）' }).waitFor();
  const recText = await p3.locator('section.panel').first().innerText();
  check('確認認定：生效日在未來→待生效', recText.includes('狀態：待生效'), recText.replace(/\s+/g, ' ').slice(0, 80));
  await p3.getByRole('button', { name: '登錄分組調價方式' }).click();
  await clickDlg(p3, '確定');
  await p3.locator('td', { hasText: 'G1CCC0000001' }).first().waitFor();
  await p3.getByRole('button', { name: '儲存', exact: true }).click();
  await p3.locator('.statusbar', { hasText: '未儲存變更：0' }).waitFor({ timeout: 10000 });
  await p3.getByRole('button', { name: '← 回認定清單' }).click();
  check('認定清單：待生效、涵蓋1品項', (await p3.locator('tr', { hasText: '介面測試認定' }).innerText()).includes('待生效'));
  // 階段7：合約、調高（範圍名單勾選）、註記、整批確認
  await p3.getByRole('button', { name: '公告與合約', exact: true }).click();
  await p3.getByRole('button', { name: '合約', exact: true }).click();
  await p3.getByRole('button', { name: '新增合約' }).click();
  let cd = p3.locator('dialog.dlg').last();
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^合約編號') }) }).locator('input').fill('K-E2E');
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^適用藥品代碼') }) }).locator('textarea').fill('A000001100');
  await clickDlg(p3, '確定');
  await p3.locator('h2', { hasText: '合約 K-E2E' }).waitFor();
  check('合約：建立並顯示適用品項', (await p3.locator('section.panel').first().innerText()).includes('適用品項（1）：A000001100'));
  await p3.getByRole('button', { name: '公告複核登記' }).click();
  const revVal = await p3.getByLabel('認定版本').locator('option', { hasText: '介面測試認定' }).getAttribute('value');
  await p3.getByLabel('認定版本').selectOption(revVal);
  const scopeRows = await p3.locator('section.panel', { hasText: '範圍名單（' }).locator('tbody tr').count();
  await p3.locator('section.panel', { hasText: '範圍名單（' }).locator('tbody input[type=checkbox]').first().check();
  await p3.getByRole('button', { name: '建立調高紀錄（勾選品項）' }).click();
  cd = p3.locator('dialog.dlg').last();
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^簽約要求') }) }).locator('select').selectOption('當時無須簽約');
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^要求依據') }) }).locator('textarea').fill('E2E 依據');
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^調高後價格') }) }).locator('input').fill('4.38');
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^調高生效日') }) }).locator('input').fill(future);
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^公告文號') }) }).locator('input').fill('健保審字第1150000001號');
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^公告日期') }) }).locator('input').fill('2026-11-01');
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^辦理狀態') }) }).locator('select').selectOption('已核定');
  await cd.locator('.form-row').filter({ has: p3.locator('.form-label', { hasText: new RegExp('^註記生效日') }) }).locator('input').fill(future);
  await clickDlg(p3, '確定');
  const paSec = p3.locator('section.panel', { hasText: '本次調高名單（' });
  await paSec.locator('td', { hasText: '可確認' }).waitFor();
  check('調高：範圍名單勾選建立1筆，註記同時建立', scopeRows >= 1 && (await p3.locator('section.panel', { hasText: '註記事件（1 筆）' }).count()) === 1);
  await paSec.locator('tbody input[type=checkbox]').first().check();
  await p3.getByRole('button', { name: '確認公告（勾選之調高及其註記）' }).click();
  await clickDlg(p3, '確認');
  await paSec.locator('td', { hasText: '已確認' }).first().waitFor();
  const paCode = (await paSec.locator('tbody tr').first().locator('td').nth(1).innerText()).trim();
  check('確認公告：調高與註記皆已確認', (await p3.locator('section.panel', { hasText: '註記事件（' }).innerText()).includes('已確認'));
  await p3.getByRole('button', { name: '儲存', exact: true }).click();
  await p3.locator('.statusbar', { hasText: '未儲存變更：0' }).waitFor({ timeout: 10000 });
  // 階段8：品項查詢、差異待辦、註記比對、匯出與反查
  await p3.getByRole('button', { name: '品項查詢', exact: true }).click();
  await p3.getByLabel('藥品代碼').fill(paCode);
  await p3.getByRole('button', { name: '查詢', exact: true }).click();
  await p3.locator('h3', { hasText: '調高（1）' }).waitFor();
  const qText = await p3.locator('section.panel').first().innerText();
  check('T21 品項查詢：認定、調高、合約、註記可回溯', qText.includes('介面測試認定') && qText.includes('4.38') && qText.includes('註記事件（1）'), qText.replace(/\s+/g, ' ').slice(0, 120));
  await p3.getByRole('button', { name: '差異待辦', exact: true }).click();
  await p3.getByRole('button', { name: /依目前主檔產生差異待辦/ }).click();
  await p3.locator('dialog.dlg').waitFor();
  check('差異待辦：可依目前主檔產生', (await dlgText(p3)).includes('比對主檔'), (await dlgText(p3)).replace(/\s+/g, ' '));
  await clickDlg(p3, '確定');
  await p3.getByRole('button', { name: '執行比對' }).click();
  await p3.locator('p', { hasText: /^比對 \d+ 項/ }).waitFor();
  check('主檔註記比對：列出結果分類', (await p3.locator('p', { hasText: /^比對 \d+ 項/ }).innerText()).includes('應有未有'));
  await p3.getByRole('button', { name: '儲存', exact: true }).click();
  await p3.locator('.statusbar', { hasText: '未儲存變更：0' }).waitFor({ timeout: 10000 });
  await p3.getByRole('button', { name: '認定', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await p3.getByRole('button', { name: '匯出認定清單' }).click();
    await clickDlg(p3, '匯出');
    await p3.waitForFunction((n) => (window.__saved || []).length >= n, i + 1);
    await p3.waitForTimeout(300);
  }
  const saved = await p3.evaluate(() => window.__saved);
  check('H15 匯出檔名：依規則、不重複、含revision', saved.length === 2 && saved[0] !== saved[1] && saved.every((x) => /^特藥_認定清單_\d{8}-\d{6}(-\d+)?_r\d{6}\.xlsx$/.test(x)), saved.join(' / '));
  const bytes = await p3.evaluate(async (n) => { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle('exports'); const f = await (await d.getFileHandle('f1')).getFile(); return Array.from(new Uint8Array(await f.arrayBuffer())); }, saved[0]);
  await p3.getByRole('button', { name: '儲存歷程', exact: true }).click();
  await p3.getByLabel('反查匯出檔').setInputFiles({ name: '改名後.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await p3.locator('p', { hasText: '「改名後.xlsx」' }).waitFor();
  const hist = await p3.locator('section.panel').first().innerText();
  check('H16 改名後依SHA-256反查匯出紀錄', hist.includes('為以下匯出') && hist.includes(saved[0]), hist.replace(/\s+/g, ' ').slice(-200));
  // 階段9：匯出備份、從備份還原
  await p3.getByRole('button', { name: '備份還原', exact: true }).click();
  await p3.getByRole('button', { name: '匯出備份' }).click();
  await p3.locator('dialog.dlg', { hasText: '備份完成' }).waitFor({ timeout: 20000 });
  const bkName = (await p3.evaluate(() => window.__saved)).at(-1);
  check('匯出備份：檔名依規則、產生後驗證', /^特藥_備份_\d{8}-\d{6}(-\d+)?_r\d{6}\.zip$/.test(bkName) && (await dlgText(p3)).includes('已重讀逐檔驗證'), bkName);
  await clickDlg(p3, '確定');
  const bkBytes = await p3.evaluate(async () => { const root = await navigator.storage.getDirectory(); const d = await root.getDirectoryHandle('exports'); const f = await (await d.getFileHandle('f' + window.__saved.length)).getFile(); return Array.from(new Uint8Array(await f.arrayBuffer())); });
  const revBefore = await p3.locator('.statusbar').innerText();
  await p3.getByRole('button', { name: '從備份還原…' }).click();
  await p3.locator('dialog.dlg').last().locator('input[type=file]').setInputFiles({ name: 'bk.zip', mimeType: 'application/zip', buffer: Buffer.from(bkBytes) });
  await clickDlg(p3, '確定');
  await p3.locator('dialog.dlg', { hasText: '確認還原' }).waitFor();
  await p3.getByLabel('還原原因').fill('E2E 演練');
  await clickDlg(p3, '還原');
  await p3.locator('dialog.dlg', { hasText: '還原完成' }).waitFor({ timeout: 20000 });
  check('T22 從備份還原：成為新revision', (await dlgText(p3)).includes('已還原為 r'), revBefore.replace(/\s+/g, ' ').slice(0, 60));
  await clickDlg(p3, '確定');
  await p3.evaluate((b) => { window.__bk = b; }, bkBytes);
  // 階段10：Excel移轉預覽（合成活頁簿；設定 SPECDRUG_WORKBOOK 時改用真實活頁簿）
  const { writeXlsx } = await import('../../src/core/xlsxWrite.js');
  const { COLS } = await import('../../src/core/migration.js');
  const ks = Object.keys(COLS);
  const synth = writeXlsx([{ name: 'final', rows: [ks.map((k) => COLS[k]),
    ks.map((k) => ({ seq: '1', group_code: 'G1AAA0000001', category: '必要藥品', rule: '分組代碼=G1AAA0000001', history: '擬訂會議113年8月' })[k] ?? null),
    ks.map((k) => ({ seq: '172', group_code: 'N03RUF212116', category: '特殊藥品', rule: '分組代碼=N03RUF212116', price_history: '參考特殊藥品精神調高，非認列', history: '擬訂會議113年8月' })[k] ?? null)] }]);
  const wbPath = process.env.SPECDRUG_WORKBOOK;
  const wbBytes = wbPath && existsSync(wbPath) ? readFileSync(wbPath) : Buffer.from(synth);
  await p3.getByRole('button', { name: 'Excel移轉', exact: true }).click();
  const tMig = Date.now();
  await p3.getByLabel('移轉活頁簿').setInputFiles({ name: wbPath ? '活頁簿1.xlsx' : 'synth.xlsx', mimeType: 'application/octet-stream', buffer: wbBytes });
  await p3.locator('h3', { hasText: '解析預覽' }).waitFor({ timeout: 60000 });
  const pvMig = await p3.locator('h3', { hasText: '解析預覽' }).locator('..').innerText();
  await p3.getByRole('button', { name: '暫存（來源檔存為附件）' }).click();
  await p3.locator('dialog.dlg', { hasText: '已暫存' }).waitFor({ timeout: 60000 });
  await clickDlg(p3, '確定');
  const migSec = p3.locator('section.panel', { hasText: '核對：' });
  await migSec.locator('tbody input[type=checkbox]').first().check();
  await migSec.locator('tbody input[type=checkbox]').nth(1).check();
  await p3.getByRole('button', { name: '寫入勾選列' }).click();
  await clickDlg(p3, '寫入');
  await p3.waitForTimeout(800);
  const bRow = p3.locator('tr', { hasText: wbPath ? '活頁簿1.xlsx' : 'synth.xlsx' }).first();
  await p3.waitForFunction((el) => el && /\t2\t0\t/.test(el.innerText.split('final')[1] || ''), await bRow.elementHandle(), { timeout: 30000 }).catch(() => {});
  const batchRow = await bRow.innerText();
  const cols = batchRow.split('\t');
  check(`T37 Excel移轉：解析預覽、暫存、寫入勾選2列（${wbPath ? '真實活頁簿' : '合成活頁簿'}，${((Date.now() - tMig) / 1000).toFixed(1)} 秒）`, cols[5] === '2' && pvMig.includes('資料列'), (pvMig + ' | ' + batchRow).replace(/\s+/g, ' ').slice(0, 200));
  await p3.getByRole('button', { name: '儲存', exact: true }).click();
  await p3.locator('.statusbar', { hasText: '未儲存變更：0' }).waitFor({ timeout: 30000 });
  // 收尾：表頭排序、列印頁尾
  await p3.getByRole('button', { name: '認定', exact: true }).click();
  if (await p3.getByRole('button', { name: '← 回認定清單' }).count()) await p3.getByRole('button', { name: '← 回認定清單' }).click();
  const th = p3.locator('th', { hasText: '編號' }).first();
  const firstCol = async () => p3.locator('table').first().locator('tbody tr td:first-child').allInnerTexts();
  await th.click();
  const asc = await firstCol();
  await th.click();
  const descRows = await firstCol();
  check('表頭點選排序（升冪／降冪）', asc.length > 1 && JSON.stringify(asc) === JSON.stringify([...asc].sort((a, b) => a.localeCompare(b, 'zh-Hant'))) && JSON.stringify(descRows) === JSON.stringify([...asc].reverse()), asc.join(',') + ' | ' + descRows.join(','));
  await p3.emulateMedia({ media: 'print' });
  await p3.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const pf = await p3.locator('#print-footer').innerText();
  check('列印頁尾：程式版本、資料revision、列印時間', /v0\.4\.0/.test(pf) && /資料 r\d{6}/.test(pf) && pf.includes('列印時間'), pf);
  await p3.emulateMedia({ media: 'screen' });
  await p3.getByRole('button', { name: '首頁', exact: true }).click();
  await p3.getByRole('button', { name: '結束編輯' }).click();
  await p3.locator('.statusbar', { hasText: '編輯牌：無人持有' }).waitFor({ timeout: 10000 });
  await p3.evaluate(() => window.localStorage.setItem('e2e.dir', 'f1'));

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
  // H11：以備份zip唯讀開啟
  await p3.getByRole('button', { name: '開啟備份zip（唯讀查詢）' }).click();
  await p3.locator('dialog.dlg').last().locator('input[type=file]').setInputFiles({ name: 'bk.zip', mimeType: 'application/zip', buffer: Buffer.from(bkBytes) });
  await clickDlg(p3, '確定');
  await p3.locator('.statusbar', { hasText: '模式：查詢' }).waitFor({ timeout: 10000 });
  await p3.getByRole('button', { name: '認定', exact: true }).click();
  const h11rows = await p3.locator('tr', { hasText: '介面測試認定' }).count();
  await p3.getByRole('button', { name: '首頁', exact: true }).click();
  const h11home = await p3.locator('main').innerText();
  const startBtn = p3.getByRole('button', { name: '開始編輯' });
  check('H11 備份zip唯讀開啟：可查詢、不可編輯', h11rows === 1 && ((await startBtn.count()) === 0 || await startBtn.isDisabled()), `${h11rows} ${h11home.replace(/\s+/g, ' ').slice(0, 200)}`);

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
