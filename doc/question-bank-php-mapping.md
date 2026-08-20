# 試題領域：PHP 對照與設計偏離

本文件記錄 `WO-ITEM-BANK`（#30）、`WO-ITEM-BANK-VALIDATION`（#35）與 `WO-QUESTION-CLUSTERS`（#37）的資料模型來源、exam-server 實作選擇，以及刻意不照抄 PHP 的地方。

## PHP 權威座標

目前可用的 PHP 權威資料來自 `exam.tw`：

- DDL：`config/db/exam_tw.sql` / `exam_tw_full.sql` 的 `questions`、`question_categories`、`question_clusters`、`question_cluster_items`、`question_groups`、`question_group_items`。
- 單題 CRUD：`src/Pages/Ajax/QuestionActions.php`。
- 題型驗證：`src/Models/Question.php::validateQuestion()`。
- 列表/搜尋：`src/Models/Question.php:848-920`。
- 分類 CRUD：`src/Pages/Ajax/CategoryActions.php`。
- 題組：`src/Models/QuestionCluster.php`。
- 題群／區塊：`src/Models/QuestionGroup.php`。

PHP 的單題核心語意是：題目以公司 (`company_id`) 隔離、公司內 `code` 唯一、單一分類、分類最多實際使用兩層，題型共 14 種，選項/答案以 JSON 保存，列表可以依建立者、題型、分類（含直屬子分類）、難度、狀態及關鍵字篩選。

## exam-server 單題資料模型

migration `006_question_bank.sql`：

- `question_categories`：tenant、parent、name、sort order、optimistic `version`、soft delete timestamps。
- `questions`：PHP 題目的主要欄位，加上 optimistic `version` 與 soft delete。
- `question_files`：把既有 `/files/*` 產生的 `fileId` 關聯到題目；可標示 stem / option / explanation / attachment，不建立第二套 upload。

`tenant_id` 在題庫表使用 opaque string 語意；程式沒有 UUID parse、UUID regex、依 UUID 結構排序或分片。

## 單題 API

versioned 路徑與既有 legacy alias 都提供：

- `GET /api/v1/questions`
- `GET /api/v1/questions/stats`
- `GET /api/v1/questions/:id`
- `POST /api/v1/questions`
- `PATCH /api/v1/questions/:id`
- `DELETE /api/v1/questions/:id?version=...`
- `GET /api/v1/question-categories`
- `GET /api/v1/question-categories/:id`
- `POST /api/v1/question-categories`
- `PATCH /api/v1/question-categories/:id`
- `DELETE /api/v1/question-categories/:id?version=...`

題目列表沿用 opaque cursor，支援 PHP 現有的 `createdBy`、`type`、`categoryId`（本分類 + 直屬子分類）、`difficulty`、`status`、`search`；`search` 對 stem / code / tags 做 substring match。

### 統計（`#98` A-5，2026-08-21 補）

PHP 題庫清單頁上方有一張統計卡：左邊一個總數、右邊逐題型的數量（`exam.tw/src/Pages/Manage/questionsView.php:17-41`）。對應到院內側是兩件事：

- **清單的 `page.total`**：套完全部篩選、**不套分頁**的筆數，對應 PHP `paginateForCompany()` 回的 `total`（`exam.tw/src/Models/Question.php:891-895`），也就是 PHP 拿去畫「總題數」的那個數（`questionsView.php:7,25`）。⚠️ 這是**共用 `PageInfo` 之外**多出來的一格，只有題目列表有。
- **`GET /api/v1/questions/stats`**：`{ total, byType }`。對應 PHP `Question::getTypeStats()`（`exam.tw/src/Models/Question.php:926-935`）。查詢條件**只有 `createdBy`**，⛔ 不吃題型／難度／狀態／關鍵字——照 PHP：統計卡本身就是逐題型分佈，再套題型篩選會讓其他題型全變 0。`byType` **十四種題型一律齊全、沒有的填 0**，對應 PHP 逐 `$available_types` 畫、缺鍵補零（`questionsView.php:30-31`）。

刻意的偏離：PHP 那張卡在 `questions_own` 模式下會跟著收窄（`$onlyMine`），院內側今天沒有那個模式——原因見下一段與 `doc/question-bank-authz-gap-audit.md`。列表與統計吃的是**同一個 `QuestionBankScope`**，所以哪一天補上收窄，兩邊會一起收窄，⛔ 不會出現「只看得到 3 題但統計說 500 題」。

### 建立者姓名（`#98` A-6，2026-08-21 補）

`Question.createdByName`：可選、可為 null 的顯示姓名，來源是 `users.display_name`（migration `015_user_display_name.sql`），查詢時 `LEFT JOIN users`。與 PHP 同形（`exam.tw/src/Models/Question.php:899-906`），且與 PHP 一樣**不用 email 遞補**——PHP 的單筆查詢雖然撈了 `creator_email`（`Question.php:970`），全 repo 沒有任何 view 消費它。

- 沒填姓名 ⇒ `null` ⇒ 呼叫端顯示 `—`（PHP 那側是 `?? '-'`，`questionViewView.php:67`）。
- 姓名怎麼填：`node scripts/create-user.mjs --email … --tenant … --roles … --name 王小明`。既有帳號沒有姓名，需要重建或另行補寫。
- ⚠️ 刻意**不放進 `AuthIdentity`**：它不是授權資訊。
- ⚠️ 誠實邊界：`LEFT JOIN` 這條只有 MySQL 整合測試碰得到，本輪環境沒有 `MYSQL_TEST_URL` ⇒ **未執行**。API 測試用的 in-memory repository 沒有 users 表，只驗得到「欄位存在且為 null」。

mutation 使用既有 AuthenticationService 與 IdempotencyStore；request ID、DomainError error contract、HTTP structured log 與既有 app middleware 共用。同公司使用者可看到彼此題目；`createdBy` 是建立者稽核欄位，不是私人資料隔離鍵。

> ⚠️ 上面這一句是**登記過的刻意偏離**，`#98` 已依工單的保險條款停手回報，未實作擁有者收窄。PHP 那側逐筆守門的完整座標、為什麼 CF 的形狀在院內接不起來、以及若裁定要做時的正確下刀處，都在 `doc/question-bank-authz-gap-audit.md`。

## 14 種題型與驗證

API enum 完整收錄 PHP 程式列出的 14 種：

`true_false`, `single_choice`, `multiple_choice`, `short_answer`, `matching`, `sorting`, `fill_blank`, `dropdown`, `choice_short_answer`, `math`, `drawing`, `development_drawing`, `interactive`, `drag_drop`。

#30 已實作：

- `true_false`：`answer.value` 為 boolean 或字串 `true` / `false`。
- `single_choice`：至少兩個 options、非空文字、answer 指向 option id。
- `multiple_choice`：至少兩個 options、非空文字、`answer.values` 至少一個且指向有效 option id。

#35 依 `Question::validateQuestion()` 全文補齊其餘 11 種：

- `short_answer`：參考答案或 keywords 至少一項；`match_mode` 僅 `any` / `all` / `manual`。
- `matching`：左右各至少兩項、至少兩組 pair，pair 的左右值都必須存在。
- `sorting`：至少兩項；order 必須存在、數量與項目一致，每個 id 必須有效。
- `fill_blank`：題幹以 `___` 標空格，答案數量相同、每格不可空，mode 僅 `exact` / `contains`。
- `dropdown`：每個 `___` 對應一組至少兩個選項；`correct` 必須是有效整數索引。
- `choice_short_answer`：至少兩個項目、至少兩個選項欄位、每個 item 一列答案，item id 與 choice index 都必須有效。
- `math`：`latex` 不可空；scoring 僅 `exact` / `equivalent`。
- `drawing`：board 四個界線完整且 min < max；背景圖 URL / position / size 規則；文字 reference element 不可空。
- `development_drawing`：chart 存在；啟用的 X/Y 軸要有名稱、min/max/interval 合法；1-10 條線、名稱唯一、每條至少兩點且點至少兩個值。
- `interactive`：若有 fields，非空欄位名需符合 `[A-Za-z_][A-Za-z0-9_]*` 且不可重複。
- `drag_drop`：至少一個 `___`、至少兩個非空且文字不重複的 options；每格指向有效 option id；未開 reusable 時答案 option 不可重複。

### PHP `empty()` 相容

#35 沒有直接拿 JavaScript truthiness 代替 PHP `empty()`。domain 明確模擬 PHP 對 `null`、`false`、數字 `0`、字串 `"0"`、空字串與空 array/object 的 empty 語意，因此例如：

- `short_answer.sample_answer = "0"` 在沒有 keywords 時仍視為空。
- `fill_blank` 的單格答案 `"0"` 視為空。
- `math.latex = "0"` 視為空。
- `drag_drop.reusable = "false"` 是非空字串，因此和 PHP 一樣會被視為「已開啟 reusable」。

這幾格有測試固定住，避免日後被「看起來比較像 JS」的重構改掉。

### 複驗 PHP 原文後發現的細節

1. `drawing` 原文註解寫「參考圖至少要有元素或背景圖片」，也建立了 `$hasBgImage`，但實際程式沒有任何一行根據 `$hasBgImage` / `$hasElements` 拒絕「兩者都沒有」的題目。exam-server 依實際控制流而不是註解，不新增這道 gate。
2. `sorting` 原文只驗 order 的長度以及每個 id 是否在 options 中，沒有檢查重複。因此兩個 options 配 `['a', 'a']` 在 PHP 會通過；#35 保留這個行為。
3. `drag_drop` 的 reusable 使用 `!empty()`；因此字串 `"false"` 其實是 truthy/reusable。#35 照原文保留。
4. #30 的 `single_choice` / `multiple_choice` 額外要求 option id 為非空且唯一字串；PHP 原文只驗 text，之後以 `array_column(..., 'id')` 做 strict membership。server 有 `question_files.option_id` 以 option id 做媒體關聯，因此保留此較嚴格規則。

## 單題刻意偏離 PHP

### 1. 保留 optimistic version

PHP 直接 overwrite，沒有版本鎖。exam-server 保留既有垂直切片的 `version`，PATCH / DELETE 必須帶版本；stale write 回 conflict。

### 2. 使用 soft delete

PHP 題目沒有 `deleted_at`。server 使用 soft delete；同 tenant + code 的唯一性只約束 active question，因此刪除後可以重用 code。

### 3. tags 改 JSON array

PHP 用逗號字串。server API 使用字串陣列、MySQL JSON 保存；搜尋仍提供 substring 行為。

### 4. 媒體使用既有 fileId

PHP 的 `stem_image` 只是路徑字串。server 先走既有 `/files/*` 完成上傳，再把 `fileId` 放入 question media relation；MySQL repository 只接受同 tenant、`ready`、未刪除的檔案。active question 仍引用檔案時，檔案 delete 會回 conflict。

### 5. 不搬 SaaS plan gating

PHP 的 `isTypeAllowedForPlan()` 是 SaaS plan gate。院內部署沒有 PHP SaaS 的 plan / upgrade 產品語意；14 種題型都可用，只保留題型本身的資料正確性驗證。

### 6. cursor pagination 取代 offset/page

PHP 回 `items / total / page`。server 沿用既有 opaque cursor，避免資料持續更新時 offset page 重複/漏項。

### 7. 分類維持兩層，不擴成任意深度

PHP 查詢語意只有指定分類 + 直屬 child；server 明確禁止第三層。

# #37 題組（cluster）與題群／區塊（group）

## PHP 真相源確認後的語意

`QuestionCluster.php` 的 model 註解明確定義 cluster 是「共同素材 + 子題」：cluster 本身有共同 `stem`，前台施測時顯示在子題上方；cluster 不支援 shuffle / skip，而且組卷時可以只挑 cluster 中部分子題。cluster item 只能是 question，PHP 沒有限制子題必須同 category/type，也沒有最少子題數。

`QuestionGroup.php` 則是編排區塊：沒有共同 stem，可混放 standalone question 與完整 cluster，並保存 `flow_mode = normal | shuffle | skip` 與可選 `subject_id`。PHP model 把 `subject_id` 用於 metadata/filter，沒有拿它限制 group 內題目或 cluster 的分類。

PHP 對 mixed items 有一個重要衝突規則：同一題不能同時以 standalone question 出現在 group，又透過該 group 內某個 cluster 再出現一次。新增 standalone question 與新增 cluster 兩個方向都會檢查這個衝突。PHP 沒有禁止兩個不同 cluster 彼此含有相同子題，因此 server 也不額外猜一條跨 cluster 禁止規則。

## migration `007_question_structures.sql`

新增四張表：

- `question_clusters`：tenant、建立者、code/name、共同 stem、`stem_file_id`、description、status、usage count、optimistic version、soft delete。
- `question_cluster_items`：cluster → question 的排序 relation。
- `question_groups`：tenant、建立者、code/name、description、subject、flow mode、status、usage count、optimistic version、soft delete。
- `question_group_items`：group 中 ordered mixed `question | cluster` relation；DB CHECK 保證 item type 與 target 欄位互斥。

所有新 tenant key 都只做 opaque string 等值比較；沒有新增 UUID 語意。

cluster 的 PHP `stem_image` 不直接搬 path。server 改用既有 private-file `stemFileId`，只接受同 tenant、ready、未刪除的 file；active cluster 還引用該檔案時，既有 file delete 會拒絕。

## API

versioned 路徑與 legacy alias 都透過既有 question-bank router 提供，共用同一套 AuthenticationService、IdempotencyStore、DomainError、request ID、structured log 與全域 audit middleware：

- `GET /api/v1/question-clusters`
- `GET /api/v1/question-clusters/:id`
- `POST /api/v1/question-clusters`
- `PATCH /api/v1/question-clusters/:id`
- `DELETE /api/v1/question-clusters/:id?version=...`
- `GET /api/v1/question-groups`
- `GET /api/v1/question-groups/:id`
- `POST /api/v1/question-groups`
- `PATCH /api/v1/question-groups/:id`
- `DELETE /api/v1/question-groups/:id?version=...`

list 沿用 opaque cursor；cluster 支援 search/createdBy/status，group 另支援 subjectId/flowMode。

## 相較 PHP 的刻意改善

### 1. item membership 採整包原子替換

PHP 提供 add/remove/reorder 多個獨立操作。server 的 POST/PATCH 直接收 ordered item array，repository 在同一 transaction 驗證 reference、更新 parent version、再 replace relation。

這不是簡化功能，而是把「改成員 + 排序」變成一次 optimistic-lock 保護的原子操作：多人同時編輯時不會出現一半 item 已加、一半排序尚未更新的中間狀態，也不需要讓前端串多個 mutation 才完成一次編排。

### 2. 保留 relation，明示 orphan

#30 的單題 soft-delete 行為不改。若 cluster 已引用的 question 後來被 soft-delete，cluster item 不會被靜默移除，而是保留 relation 並回 `available: false`。group item 同樣保留 `available` 狀態。這讓管理端能看見壞掉的引用，而不是把「原本沒有」和「後來消失」混為一談。

cluster 若仍被 active group 引用，cluster DELETE 會回 conflict，避免主動製造 group → cluster orphan。

### 3. PATCH 可寫基底零 default

cluster/group 都遵守 #30 修過的 zod 規則：可寫 base schema 完全沒有 `.default()`；只有 create schema 才加預設值。PATCH 沒送的欄位保持原值，不會因 `.partial()` + inner default 靜默重設。

## runtime 部署對照尚未完成

issue 已知 `exam-runtime` 的 `booklet_data` 有 `clusters`，但本輪可用的 GitHub connector 能讀 `exam.tw`，沒有 `exam-runtime` repository，因此無法取得 `types-deploy.ts` 的 cluster 完整型別。

本批只保證資料模型能保存「cluster 共同素材 + ordered child question ids」這個 PHP 已確認的核心形狀；**尚未宣稱欄位名稱或序列化 shape 已與 runtime `booklet_data.clusters` 完全一致**。實際 deployment/export 也不在 #37 範圍內，待 runtime truth source 可讀後再做精確 mapping。
