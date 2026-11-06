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
