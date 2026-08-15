# 試題領域：PHP 對照與設計偏離

本文件記錄 `WO-ITEM-BANK`（#30）與 `WO-ITEM-BANK-VALIDATION`（#35）的資料模型來源、exam-server 實作選擇，以及刻意不照抄 PHP 的地方。

## PHP 權威座標

目前可用的 PHP 權威資料來自 issue #30 / #35 提供的 `exam.tw` 座標：

- DDL：`config/db/exam_tw.sql` / `exam_tw_full.sql` 的 `questions`、`question_categories`。
- CRUD：`src/Pages/Ajax/QuestionActions.php`。
- 題型驗證：`src/Models/Question.php::validateQuestion()`；#35 提供 `:364-829` 全文。
- 列表/搜尋：`src/Models/Question.php:848-920`。
- 分類 CRUD：`src/Pages/Ajax/CategoryActions.php`。

PHP 的核心語意是：題目以公司 (`company_id`) 隔離、公司內 `code` 唯一、單一分類、分類最多實際使用兩層，題型共 14 種，選項/答案以 JSON 保存，列表可以依建立者、題型、分類（含直屬子分類）、難度、狀態及關鍵字篩選。

## exam-server 資料模型

新增 migration `006_question_bank.sql`：

- `question_categories`：tenant、parent、name、sort order、optimistic `version`、soft delete timestamps。
- `questions`：PHP 題目的主要欄位，加上 optimistic `version` 與 soft delete。
- `question_files`：把既有 `/files/*` 產生的 `fileId` 關聯到題目；可標示 stem / option / explanation / attachment，不建立第二套 upload。

`tenant_id` 在這批新表使用 `VARCHAR(191)` 並只做等值隔離。程式把它當 opaque string；沒有 UUID parse、UUID regex、依 UUID 結構排序或分片。這是為了配合後續 tenant identity 統一到 `company_id` 的獨立 migration，不在 #30 偷做 identifier migration。

#35 只補 domain validation，沒有變更上述資料表、repository 或 API schema。

## API

versioned 路徑與既有 legacy alias 都提供：

- `GET /api/v1/questions`
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

新 mutation 使用既有 AuthenticationService 與 IdempotencyStore；request ID、DomainError error contract、HTTP structured log 與既有 app middleware 仍共用。同公司使用者可看到彼此題目；`createdBy` 是建立者稽核欄位，不是私人資料隔離鍵。

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

1. `drawing` 原文註解寫「參考圖至少要有元素或背景圖片」，也建立了 `$hasBgImage`，但實際程式沒有任何一行根據 `$hasBgImage` / `$hasElements` 拒絕「兩者都沒有」的題目。exam-server 依**實際控制流**而不是註解，不新增這道 gate，避免把 PHP 可接受的既有資料突然判成非法。
2. `sorting` 原文只驗 order 的長度以及每個 id 是否在 options 中，**沒有檢查重複**。因此兩個 options 配 `['a', 'a']` 在 PHP 會通過；#35 保留這個行為並用測試固定，沒有擅自加「必須是 permutation」規則。
3. `drag_drop` 的 reusable 使用 `!empty()`；因此字串 `"false"` 其實是 truthy/reusable。#35 照原文保留。
4. #30 的 `single_choice` / `multiple_choice` 額外要求 option id 為非空且唯一字串；PHP 原文只驗 text，之後以 `array_column(..., 'id')` 做 strict membership。這是已存在的 server-side stricter behavior。#35 **沒有改動這三種既有題型**，依紅線只登記差異。server 有 `question_files.option_id` 以 option id 做媒體關聯，因此禁止空／重複 id 可避免附件指向不明；目前保留此改善。

## 刻意偏離 PHP

### 1. 保留 optimistic version

PHP 直接 overwrite，沒有版本鎖。exam-server 保留既有垂直切片的 `version`，PATCH / DELETE 必須帶版本；stale write 回 conflict。使用者在多人同時編題時不會無聲覆蓋別人的修改。

### 2. 使用 soft delete

PHP 題目沒有 `deleted_at`。server 使用 soft delete；同 tenant + code 的唯一性只約束 active question，因此刪除後可以重用 code，同時保留恢復/稽核空間。

### 3. tags 改 JSON array

PHP 用逗號字串。server API 使用字串陣列、MySQL JSON 保存，避免 tag 本身含分隔字元或 trim 規則不一致；搜尋仍提供 PHP 使用者熟悉的 substring 行為。

### 4. 媒體使用既有 fileId

PHP 的 `stem_image` 只是路徑字串，刪題也不清檔；server 不再讓 domain data 自己拼 filesystem path。先走既有 `/files/*` 完成上傳，再把 `fileId` 放入 question media relation。MySQL repository 只接受同 tenant、`ready`、未刪除的檔案。

本批不自動刪媒體檔：題目 soft delete 只解除 active reference 語意，檔案生命週期仍由既有 `/files/*` 明確操作，避免刪題時把可能被別處使用的檔案一起誤刪。反方向則加上 guard：active question 仍引用 `fileId` 時，既有 `/files/:id` delete 會回 conflict，必須先從題目移除關聯。

### 5. 不搬 SaaS plan gating

PHP 的 `isTypeAllowedForPlan()` 是 SaaS plan gate。院內部署沒有 PHP SaaS 的 plan / upgrade 產品語意；把 gate 搬過來反而需要虛構不存在的方案設定，並可能無故停用合法題型。因此 #35 延續 #30 決策：14 種題型都可用，只保留題型本身的資料正確性驗證。

### 6. cursor pagination 取代 offset/page

PHP 回 `items / total / page`。server 沿用既有 opaque cursor，避免資料持續更新時 offset page 重複/漏項，也保持和 `/items` 的 API 習慣一致。這批不為了相容 PHP 另造 offset endpoint。

### 7. 分類維持兩層，不擴成任意深度

PHP 查詢語意只有指定分類 + 直屬 child；目前沒有 recursive grandchildren。server 明確禁止第三層，讓資料形狀與實際產品行為一致，而不是存得進卻查不完整。

## 尚未納入

PHP schema 還提到 `question_clusters` / `question_cluster_items` 與 `question_groups` / `question_group_items`。目前工單要求的是單題 CRUD、列表/分類查詢、檔案關聯與 14 題型 validation；題群/群組的產品語意尚未提供，因此沒有猜測性實作。
