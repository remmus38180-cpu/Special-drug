# 特殊藥品認定、調高及供貨合約管理系統（P0）

依《程式規格書 v0.3.1（2026-10-18）》實作之桌面程式。Python 3.12 + tkinter + SQLite，打包為免安裝執行套件；不需網路API、雲端或常駐伺服器。

> **版本狀態：離線原型＋共用版機制已實作，但「正式共用版」尚未在機關實際共用槽完成環境驗收。**
> 啟動畫面橫幅會明示「離線原型」或共用槽版本；共用槽未通過鎖定／不可分割替換驗證時，正式編輯模式自動停用（T32）。

## 0. 不打包直接開啟（Windows，給第一次使用者）

1. 安裝 Python 3.12：到 https://www.python.org/downloads/windows/ 下載「Windows installer (64-bit)」，安裝第一個畫面**勾選「Add python.exe to PATH」**再按 Install Now。（機關電腦若不能自行安裝，請資訊單位代裝。）
2. 下載程式：GitHub 本專案頁 → 切到分支 `ccr-77e3d4b8-ar999t` → 綠色「Code」→「Download ZIP」→ 解壓縮到例如 `D:\specdrug`。
3. 點兩下 `start_windows.bat`。第一次會花約1分鐘準備（需能連 pypi.org 下載 openpyxl、tzdata），之後點兩下即開。
4. 想先看範例：關閉系統視窗後點兩下 `demo_data_windows.bat`，再開 `start_windows.bat`。
5. 沒有 `config.json` 時是**離線原型**，資料只在自己電腦 `%LOCALAPPDATA%\specdrug\offline\`；刪除該資料夾即清空。

## 1. 啟動與停止

| 情境 | 方式 |
|---|---|
| 使用者（Windows） | 執行 `specdrug.exe`（由 `tools\build_windows.bat` 產生的 `dist\specdrug\` 整個資料夾）。不需安裝 Python。 |
| 開發 | `pip install -r requirements.txt`，`python run_app.py` |
| 停止 | 關閉視窗。編輯中會提示：發布／保留本機草稿／放棄。 |

設定檔 `config.json`（放執行檔旁，範例見 `config.example.json`）：
- 未設 `store_root` → **離線原型**（單機 `%LOCALAPPDATA%\specdrug\offline\offline.sqlite`）。
- 設 `store_root` → 共用版。首次開啟若共用槽未初始化，詢問是否以目前 Windows 帳號為管理者初始化（先自動跑環境驗證，未通過拒絕初始化）。

## 2. 使用模式（規格 4.2–4.3）

- 預設**查詢模式**：讀取共用槽目前版本指標 → 下載不可變版本到本機 → 驗證 SHA-256 → 唯讀開啟。橫幅顯示版本、發布時間、目前編輯者；有新版提示重新整理，查詢中途不混用版本。
- **開始編輯**：取得全系統獨占編輯權（`control/edit.lock`，Windows byte-range lock／POSIX flock，由檔案伺服端仲裁；鎖檔永不刪除重建）。複製最新版到本機工作區修改；草稿存本機可復原。
- **發布**：在持有編輯權下 → 確認目前版本仍是基準版本 → 寫入 `staging` → 完整性檢查與附件雜湊 → 改名為 `releases/<id>`（不可變）→ `os.replace` 切換 `control/current.json`。任何失敗不切換。唯一操作id防重送（T29）。
- 斷線／鎖有效性不明 → 立即禁止寫入與發布，本機內容保留為待復原草稿；重新取得編輯權時若基準已變，舊草稿另存 `recovery-*`，不得整份覆蓋（T28）。

共用槽目錄：`app／control／releases／attachments／staging／backups`。

## 3. 功能（P0）

| 分頁 | 內容 |
|---|---|
| 案件 | 基本收案（含未通過、撤回、辦理中）、品項、登錄提會、逐品項決議（專家建議／會議決議分開）、結果摘要（須連結依據）、結案、再提新案、附件 |
| 會議 | 會議共用（同次多案），議案與決議各自關聯 |
| 認定 | 認定項目／版本（更正、取消皆新增版本）、規則編輯（範本、群組AND/OR/排除、主檔點選、人工條件）、預覽、快照、人工確認（逐筆或依原因批次）、確認、分組調價方式 |
| 公告複核 | 只能從已確認範圍名單勾選 → 逐項價格／簽約要求／合約／生效日 → 逐項驗證錯誤 → 單一交易確認調高與註記 |
| 合約 | 合約、補充協議鏈、適用品項期間、文件版本、到期提醒（不自動取消） |
| 品項明細 | 依代碼回溯收案、會議、認定、調高、合約、註記；指定日期查詢；多認定類別衝突顯示來源 |
| 主檔匯入 | xlsx/UTF-8 CSV、選工作表／標題列、欄位映射（預設：月產製 dwm_drug、SQL Server DWM_DRUG layout）、RCODE代碼轉換、DRPAY價格長表依基準日、試匯入檢核、啟用、版本差異 |
| 差異待辦 | 新符合、不再符合、分組異動、主檔消失；必要藥品註記比對（DRUG_NECESSARY；一致／應有未有／主檔有但無完整依據／類別不同／無法判定） |
| Excel移轉 | 活頁簿1 final 逐列暫存（來源雜湊、列號、原文、解析、待確認問題）、合併候選、確認寫入（認定一律草稿） |
| 稽核／管理 | 稽核紀錄（只追加，DB trigger 阻擋修改刪除）、帳號角色、環境驗證、備份／驗證／還原、版本歷史 |

匯出（xlsx／CSV）附匯出時間、查詢條件、主檔版本、基準日、資料版本，並防公式注入。

## 4. 程式結構

```
specdrug/
  db.py            資料表（規格 6.2 全部）、交易
  core.py          權限檢查、稽核、樂觀版本、操作id
  cases.py         收案、會議、議案、決議、逐品項結果
  rules.py         條件AST白名單驗證、三值判定、原文規則草稿解析
  master_import.py 主檔匯入、映射、檢核、啟用、差異、RCODE/DRPAY
  recognition.py   認定、版本、預覽、快照、衝突、分組調價方式
  pricing.py       合約、調高、註記、公告確認、主檔比對、差異待辦
  query.py export.py attachments.py auth.py
  store.py         共用槽鎖定、發布、指標、附件、備份還原、環境驗證
  workspace.py     查詢模式／編輯模式工作階段
  migration.py     活頁簿1移轉
  gui/             tkinter 介面
tests/             T01–T40 自動驗收
tools/             build_windows.bat、seed_demo.py（模擬資料）、perf_check.py、real_data_check.py
docs/              驗收結果、資料對照與發現、操作與維運
```

## 5. 驗證

```
python -m pytest -q tests          # T01–T40
python tools/perf_check.py         # 5萬品項／2千認定效能
python tools/seed_demo.py demo_data  # 模擬資料（離線原型）
```

結果與未完成項見 `docs/驗收結果.md`；資料欄位對照與真實資料檢查發現見 `docs/資料對照與發現.md`。

## 6. 已知限制

- 共用槽鎖定、`os.replace`、斷線／快取／舊編輯者復活須在**機關實際共用槽**驗收（規格 4.3、Q08）；本環境以本機檔案系統與多程序模擬通過。
- Windows 執行套件需在 Windows 開發機以 `tools\build_windows.bat` 產生（本開發環境為 Linux，未產出 .exe）。
- 應用層角色與稽核不是防竄改安全邊界；共用槽目錄 ACL（查詢者不得寫 releases／control）須由檔案伺服器設定。
- 待確認事項 Q01–Q09 未自行編造答案：起日、部分涵蓋分組、全面簽約起日、Warfarin同廠牌及「=0」、RO5DA04 等均保留待確認。
- 補件提醒、排程、履約追蹤、公文／正式主檔介接屬 P1。
