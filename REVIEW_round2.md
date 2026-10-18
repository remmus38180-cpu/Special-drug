# REVIEW_round2 — 獨立審查（第二輪）

- 對象：`remmus38180-cpu/Special-drug` 分支 `ccr-77e3d4b8-ar999t` @ `85f84fd`
- 依據：`docs/程式規格書_v0.3.1.md`（repo內無v0.3；使用者上傳檔與repo版逐位元相同）
- 範圍：①共用槽鎖定／發布／指標／斷線／復活／操作id（§4.3、§11、T16、T26–T32）②備份還原、附件完整性、路徑安全（§13、T22）③角色越權（§5、T23）④已確認資料、快照、稽核不可覆寫（§6.1、B10）
- 未改 `specdrug/`。重現測試：`tests/review_round2/test_review_round2.py`（8項，現況全數失敗）

## 測試結果

| 項目 | 結果 |
|---|---|
| `python -m pytest -q tests`（原有） | 68 passed、2 skipped |
| 跳過原因 | GUI smoke：環境無tkinter；T37_T38：測試寫死舊上傳路徑 |
| T37_T38 以本次上傳 `活頁簿1.xlsx`（final 287列×17欄）放至該路徑另跑 | passed |
| `tests/review_round2`（新增） | 8 failed（預期，皆為重現） |

---

## 一、重大（違反規格且有失敗測試）

### M1 舊編輯者復活，於新編輯者持鎖期間仍可發布
- 規格：§4.3「發布期間必須持續持有有效獨占權」「不得…允許兩個編輯者」；T28
- 位置：`specdrug/store.py:111-123` `EditLock.valid()`；`store.py:259`、`:314` 呼叫處
- 原因：`valid()` 以「另開控制代碼試鎖，試不到＝我仍持有」判定。斷線後伺服端已釋放舊鎖、新編輯者取得鎖時，舊者試鎖同樣失敗→誤判有效。基準版本未變（新者尚未發布）→舊者發布成功並切換指標。
- 原T28測試只模擬「舊者控制代碼已關閉」及「新者已發布」兩情境，未涵蓋本窗口。
- 重現：`test_R2_01_revived_editor_cannot_publish_while_new_editor_holds_lock`（DID NOT RAISE LockLost）
- 建議修法：有效性不得以「他人取不到鎖」推論。改為正向證明自身持有，例如：
  1. 取鎖後於鎖檔（或control下伴隨檔）寫入本工作階段唯一token；`valid()` 經同一控制代碼讀回token並比對，且`editor.json`/token檔之token須相符；新編輯者取鎖時覆寫token→舊者必失效。
  2. Windows：以同一控制代碼對已鎖位元組作讀寫探測（他人持鎖時同控制代碼存取會被拒），不另開代碼。
  3. 發布切換前再比對token；不符即LockLost。
  修後補測：新者持鎖未發布、舊者發布→LockLost且指標不變。

### M2 查詢者可取得全系統編輯權並發布
- 規格：§5「查詢者…不得具發布目錄寫入權」「權限須由…發布模組檢查，不能僅隱藏按鈕」；T23「查詢角色嘗試修改／發布→程式阻止」
- 位置：`specdrug/workspace.py:146`（`if not roles_of(...)` 僅檢查「有任何角色」）；`workspace.py:157-167`、`store.py:257` 發布無角色檢查
- 影響：查詢者可佔住全系統唯一編輯權（阻擋他人），並發布（含程式外直接改本機`work.sqlite`後發布）。
- 重現：`test_R2_05_viewer_role_cannot_take_edit_lock_or_publish`
- 建議修法：`start_edit` 要求 `{登記者, 複核登記者, 管理者}` 至少一項；`Workspace.publish`／`SharedStore.publish` 以發布當下工作庫之角色再檢查（防取鎖後降權）。誰可發布見灰區G1。

### M3 登記者可經 `update_price_action` 直接把調高設為「已確認」
- 規格：§5（確認限複核登記者）；§9.2-6～8、末段「須簽約卻缺完成簽署合約，不得確認調高結果」；T09
- 位置：`specdrug/pricing.py:153-167`（無欄位白名單，`changes`原樣交 `core.update`）
- 影響：繞過 `confirm_announcement` 的角色檢查、`validate_price_action` 缺件／範圍／公告文號檢查，及op_id。亦可改 `revision_id`、`drug_code` 繞過範圍外勾入限制、改 `confirmed_by`。
- 重現：`test_R2_06_clerk_cannot_set_confirm_status_via_update_price_action`
- 建議修法：比照 `update_revision`／`update_case` 設白名單（價格、日期、文號、簽約要求與依據、合約、狀態、備註、completeness）；`confirm_status`、`confirmed_*`、`revision_id`、`drug_code`、`snapshot_id`、`supersedes_id`、`created_*`、`id` 一律拒絕；改 `drug_code`／`revision_id` 須重走範圍檢查或禁止。
  通用防線：`core.update` 拒絕 `id`、`created_by`、`created_at`、`confirm_status`、`confirmed_by`、`confirmed_at`，除非呼叫端明示允許。

### M4 `update_contract` 可改寫建立者等任意欄位
- 規格：§6.1「記錄建立者、建立時間…」「已確認資料可修正，但應建立新版本，保留原內容、修改人、時間與原因」
- 位置：`specdrug/pricing.py:65-74`（無白名單）
- 影響：可改 `created_by`／`created_at`、`original_contract_id`（改接合約鏈，T15）等；不檢查 `status` 值域（交DB CHECK）。
- 重現：`test_R2_07_update_contract_cannot_rewrite_creator_fields`
- 建議修法：白名單（合約編號、廠商、日期、文件版本、義務摘要、狀態）；狀態值域於程式檢查；`original_contract_id` 只在建立時給。已被已確認調高引用之合約能否原地修改見灰區G4。

### M5 登記者可單獨擴大「已確認」認定的範圍名單
- 規格：§5（確認登記內容限複核登記者）；§6.1／B10（不覆寫已確認歷程）；T13「新符合…待確認，不自動註記或調高」
- 位置：`specdrug/recognition.py:195-217` `save_snapshot`（對已確認版本、任意匯入版本皆可）；`recognition.py:268-282` `confirm_snapshot`（`EDIT_ROLES`，含登記者）；`recognition.py:313-321` `revision_scope` 取所有已確認快照聯集
- 影響：登記者以自己試匯入（未啟用）的主檔建快照並確認→已確認認定範圍新增品項，無複核、無新版本；後續 `create_price_action` 範圍檢查即放行。
- 重現：`test_R2_08_clerk_cannot_expand_scope_of_confirmed_revision`（新增 `Z000009100`）
- 建議修法（擇一，須業務同意見G5）：
  1. 對 `confirm_status='已確認'` 之版本，`confirm_snapshot` 限 `複核登記者`，並以 op_id 記錄；或
  2. 已確認版本之新快照只列「新符合待確認」差異待辦（T13），範圍擴增須建立新認定版本再確認。
  兩案皆應限制快照只能用 `已啟用` 主檔，或至少確認時阻擋 `試匯入／失敗` 狀態。

### M6 重新開始編輯時未以op_id辨識「已發布」，誤判衝突
- 規格：§11「斷線後先查該id是否已成為已發布版本，再決定顯示成功或重試；禁止盲目重複建立事件」
- 位置：`specdrug/workspace.py:130-137` `start_edit` 只比 `draft.base` 與目前版本；`workspace.py:163-166` 指標切換成功後才寫回 `draft.json`
- 情境：指標已切到本操作，但本機寫回前中斷（當機、斷線）。重開後判為 `recovered`、草稿移入recovery並提示「請核對後重套變更」；使用者重套即重複建立案件／事件。
- 重現：`test_R2_02_restart_after_lost_publish_ack_recognizes_op_id`
- 建議修法：`start_edit` 遇 `draft.base != base` 時先 `find_release_by_op(draft.op_id)`；若該release存在且為目前版本或其祖先→回報「先前發布已完成」，以目前版本重建工作副本，不進recovery；僅在op未發布時才走recovery。

### M7 還原只驗證manifest所列檔案；manifest漏列 data.sqlite 即放行
- 規格：§13「備份…完成雜湊驗證」「還原須…以新發布版本引用舊內容」；T22
- 位置：`specdrug/store.py:468-479` `verify_backup`；`store.py:417-425` `restore`
- 影響：`backup_manifest.json` 缺 `data.sqlite` 鍵（損毀、手動編修）時，任意替換的資料庫通過驗證並發布為正式版本。
- 重現：`test_R2_03_restore_rejects_backup_whose_manifest_omits_data_hash`
- 建議修法：`verify_backup` 強制要求 `data.sqlite` 在列；並交叉比對 `release_manifest.json` 之 `files.data.sqlite` 與 `backup_manifest.release_id`；資料庫內每筆 `attachment` 皆須在manifest以相同sha列出；`restore` 讀取 `data.sqlite` 前重算雜湊（不只信 `verify_backup` 結果）。

---

## 二、灰區（規格未定，須業務決定；未自行決定）

| ID | 議題 | 現況（檔案:行） | 選項與影響 |
|---|---|---|---|
| G1 | 登記者可否發布 | 任一可編輯角色皆可發布（`workspace.py:157`） | A.允許：§4.2「已發布資料可含草稿」可行；正式狀態仍靠複核確認。B.限複核登記者：符合§9.2-8字面「複核登記者確認發布」，登記者草稿須交人發布，流程變慢。 |
| G2 | 管理者自動取得業務核定權 | 初始化者固定 `管理者,複核登記者`（`auth.py:26`）；管理者可自行指派任何角色（`auth.py:242`） | A.維持（§5「目前使用者擔任複核登記者」）。B.初始化只給管理者，複核角色另行指派並留稽核：符合§5「不因系統管理權限自動取得」。C.禁止管理者指派自己業務角色（需第二位管理者）：單人單位不可行。 |
| G3 | 會議逐品項結果、案件結果摘要可原地改寫 | `set_decision_drug` 同品項再登錄即覆蓋（`cases.py:197-199`）；`set_case_summary` 刪除重建依據連結（`cases.py:221`）；兩者無確認狀態 | A.視為登錄中資料，可改（僅稽核留痕）。B.改為新增紀錄／取代關聯（B14「不相互覆蓋」精神）：歷程完整，介面須顯示最新有效值。決議是否屬§6.1「已確認資料」須定義。 |
| G4 | 已被「已確認調高」引用之完成簽署合約可否原地修改 | 合約無確認狀態，可改日期、狀態（`pricing.py:65-74`） | A.可改（B18不查合約起訖）。B.被引用後鎖定，更正須以補充協議／新版合約（`original_contract_id`）。B較符合B10，但更正小錯成本高。 |
| G5 | 快照可否採未啟用主檔 | `save_snapshot` 不檢查匯入狀態（`recognition.py:195`） | A.允許試匯入預覽、確認時須已啟用。B.一律限已啟用。C.維持。關聯M5。 |
| G6 | 查詢者下載合約附件 | 所有角色皆可下載（`attachments.py:88`） | §5「依授權下載」、§10合約「下載須經授權」未定授權粒度。A.全開。B.合約類附件限登記者以上或另設授權名單。 |
| G7 | 還原後，備份時點之後的業務資料自現行版本消失 | 僅併入現行稽核（`store.py:428`、`:438-450`） | A.維持（舊release仍保留、可查）。B.還原前強制先備份現行版並於稽核記錄其release_id。C.提供差異清單供重套。須配合Q09（RPO/RTO）。 |

---

## 三、輕微（不影響正確性）

### L1 `verify_backup` 檔案路徑未限制在備份目錄內
- 規格：§13（路徑安全）
- 位置：`specdrug/store.py:474`（`Path(dest) / rel`，`rel` 可為 `../`）
- 影響：僅讀取驗雜湊，不寫入；但驗證可被目錄外檔案滿足。與M7一併修。
- 重現：`test_R2_04_verify_backup_rejects_paths_outside_backup`
- 建議修法：`rel` 限 `data.sqlite` 或 `attachments/<storage_key>` 格式，並以 `resolve()` 確認位於備份目錄內。

---

## 四、需實地驗收（Linux無法驗證）

前置：兩台以上機關電腦（A、B，另C作查詢）、實際共用槽UNC路徑、正式打包之exe；每步截圖並記錄 `control/current.json`、`control/editor.json`、`releases/` 清單。

| ID | 項目 | 規格 | 步驟 | 通過條件 |
|---|---|---|---|---|
| F1 | Windows位元組鎖跨機互斥 | §4.3、T16、T31 | 1.A開始編輯。2.B（同帳號、異帳號各一次）按開始編輯。3.管理者「共用槽環境驗證」。 | B顯示「其他人正在編輯」及A資訊；環境驗證全通過。 |
| F2 | 斷線後鎖由伺服端釋放 | §4.3、T27 | 1.A開始編輯並新增案件。2.拔A網路線（或停用網卡）5分鐘。3.B開始編輯。4.恢復A網路。 | B可取得鎖前，須確認A的SMB工作階段已失效（伺服器「開啟的檔案」看不到A對`edit.lock`之控制代碼）；A畫面顯示編輯權有效性不明、禁止發布。 |
| F3 | M1情境實機重現 | §4.3、T28 | F2第3步B取得鎖後**不發布**；A恢復網路後按「發布」。 | A被拒（現況程式預期會成功→M1）。修正後重驗。 |
| F4 | 指標替換不可分割 | §4.3、T29、T30 | 1.C開查詢並連續重新整理（每秒）。2.A發布；發布過程中拔A網路。3.A恢復後再按發布。 | C不出現讀取錯誤、不讀到半寫`current.json`；`releases/`該op_id只一份有效且被指標引用；`staging`殘留`.partial`不被讀取。 |
| F5 | 目錄改名（staging→releases） | §4.3 | 發布大型資料（含50MB附件）時觀察；同時讓C開啟`releases`目錄。 | 改名成功或整體失敗不切指標；無半成品release。 |
| F6 | 檔案占用／防毒 | §4.3 | 1.以另一程式開啟`control/current.json`（記事本、或防毒掃描）。2.A發布。 | 重試後成功或明確失敗且指標不變；不出現兩份指標。 |
| F7 | SMB用戶端快取 | §4.3、§11 | 1.C開啟查詢。2.A發布。3.C於30秒內按重新整理，重複5次。 | C最終取得新版且雜湊相符；不混用版本（橫幅版本id與資料一致）。若有延遲記錄秒數。 |
| F8 | 鎖檔身分（inode） | §4.3 | 在共用槽查`os.stat(edit.lock).st_ino`是否為0（可用exe診斷或PowerShell `fsutil file queryfileid`）。 | 若SMB回傳0，`valid()`第119行身分比對被略過，須改用檔案ID或token（見M1）。 |
| F9 | ACL：查詢者不可寫 | §5、T23 | 以查詢者帳號在檔案總管對`releases`、`control`、`staging`、`attachments`嘗試新增／改名／刪除檔案。 | 全部被拒；可讀`releases`、`control/current.json`。 |
| F10 | ACL：發布目錄不可改寫 | §4.3、§6.1 | 以編輯者帳號嘗試修改既有`releases/<id>/data.sqlite`、刪除`attachments`檔。 | 若可改：應由伺服器設「只可建立不可修改」，否則不可變release僅靠程式約定（§5已述非防竄改邊界，須業務接受）。 |
| F11 | 程序被強制結束 | T27 | A編輯中以工作管理員結束程序；B立即開始編輯。 | B可取得；A重開為「resumed」並保有草稿；`edit.lock`未被刪除重建（檔案建立時間不變）。 |
| F12 | 備份還原演練 | §13、T22、Q09 | 1.管理者備份目前版本至`backups`。2.另發布一版。3.還原備份並填原因。4.C重新整理；開附件；依代碼查歷程。 | 附件雜湊一致、案件／認定／快照／合約附件關聯正確、稽核含「還原」；舊release未變；記錄耗時（供RTO）。 |
| F13 | T32 降級阻擋 | §4.3、T32 | 在不支援鎖的位置（如同步雲端資料夾或映射之WebDAV）建立共用槽。 | 初始化或開始編輯被拒，不以旗標鎖替代。 |

---

## 五、未列入（無法以測試重現，供參）

- GUI還原每次點擊產生新 `op_id`（`gui/tabs_misc.py:593`）：指標已切換但畫面顯示失敗後再按，會再建一個還原release。環境無tkinter未能重現；建議以同一對話框保存op_id直到成功或取消。
- 查詢離線時改開本機快取最新檔（`workspace.py:93-98`），未重驗雜湊；快取僅本機可寫，未構成規格違反。
- 被殺程序留下之 `staging/*.partial` 不會清除；查詢不讀staging，不影響正確性。

## 六、本輪確認無問題（抽查）

- 發布前後兩次檢查鎖有效與基準版本，切換在持鎖下完成（`store.py:259-271`、`:313-325`）。
- 同op_id重送：已發布→回傳同版本；已建release未切換→補切換（T29）。
- 附件以 `sha[:2]/sha` 為鍵、`storage_path` 拒穿越（`store.py:76-83`）；上傳、發布、下載皆驗雜湊。
- 稽核表有 UPDATE／DELETE 觸發器阻擋（`db.py:352-355`）；還原併入現行稽核。
- 已確認認定版本、已確認快照名單、已確認調高（經正常更新入口）不可修改；撤銷限未確認版本。
