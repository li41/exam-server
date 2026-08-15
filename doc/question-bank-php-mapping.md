# 試題領域：PHP 對照與設計偏離

本文件記錄 `WO-ITEM-BANK`（#30）第二階段的資料模型來源、exam-server 實作選擇，以及刻意不照抄 PHP 的地方。

## PHP 權威座標

目前可用的 PHP 權威資料來自 issue #30 提供的 `exam.tw` 座標：

- DDL：`config/db/exam_tw.sql` / `exam_tw_full.sql` 的 `questions`、`question_categories`。
- CRUD：`src/Pages/Ajax/QuestionActions.php`。
- 題型驗證：`src/Models/Question.php::validateQuestion()`。
- 列表/搜尋：`src/Models/Question.php:848-920`。
- 分類 CRUD：`src/Pages/Ajax/CategoryActions.php`。

PHP 的核心語意是：題目以公司 (`company_id`) 隔離、公司內 `code` 唯一、單一分類、分類最多實際使用兩層，題型共 14 種，選項/答案以 JSON 保存，列表可以依建立者、題型、分類（含直屬子分類）、難度、狀態及關鍵字篩選。

## exam-server 資料模型

新增 migration `006_question_bank.sql`：

- `question_categories`：tenant、parent、name、sort order、optimistic `version`、soft delete timestamps。
- `questions`：PHP 題目的主要欄位，加上 optimistic `version` 與 soft delete。
- `question_files`：把既有 `/files/*` 產生的 `fileId` 關聯到題目；可標示 stem / option / explanation / attachment，不建立第二套 upload。

`tenant_id` 在這批新表使用 `VARCHAR(191)` 並只做等值隔離。程式把它當 opaque string；沒有 UUID parse、UUID regex、依 UUID 結構排序或分片。這是為了配合後續 tenant identity 統一到 `company_id` 的獨立 migration，不在 #30 偷做 identifier migration。

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

## 14 種題型與驗證邊界

API enum 完整收錄 PHP 程式列出的 14 種：

`true_false`, `single_choice`, `multiple_choice`, `short_answer`, `matching`, `sorting`, `fill_blank`, `dropdown`, `choice_short_answer`, `math`, `drawing`, `development_drawing`, `interactive`, `drag_drop`。

Issue 提供了 PHP `validateQuestion()` 中三種題型的具體規則，因此 server 直接守同一語意：

- `true_false`：`answer.value` 必須是 boolean 或字串 `true` / `false`。
- `single_choice`：至少兩個 options，每個要有非空 `id` / `text`，`answer.value` 必須指向 option id。
- `multiple_choice`：同樣要求 options，`answer.values` 至少一個且每個都必須指向 option id。

其餘 11 種的完整 PHP switch 內容尚未提供。這批會保存其 JSON，但不憑空發明 answer/options schema；拿到真正 `validateQuestion()` 分支後可追加精確規則，不需要改資料表。

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

### 5. retention of PHP plan gating：不搬 SaaS 限制

PHP 的 `isTypeAllowedForPlan()` 是 SaaS plan gate。這台是院內題庫後端；#30 沒要求把商業方案限制搬進來，因此 14 種題型全部是 server contract 的合法型別。

### 6. cursor pagination 取代 offset/page

PHP 回 `items / total / page`。server 沿用既有 opaque cursor，避免資料持續更新時 offset page 重複/漏項，也保持和 `/items` 的 API 習慣一致。這批不為了相容 PHP 另造 offset endpoint。

### 7. 分類維持兩層，不擴成任意深度

PHP 查詢語意只有指定分類 + 直屬 child；目前沒有 recursive grandchildren。server 明確禁止第三層，讓資料形狀與實際產品行為一致，而不是存得進卻查不完整。

## 尚未納入本批

PHP schema 還提到 `question_clusters` / `question_cluster_items` 與 `question_groups` / `question_group_items`。#30 本批要求的是單題 CRUD、列表/分類查詢與檔案關聯；題群/群組的產品語意尚未提供，因此沒有猜測性實作。

另外，11 種非 true/false、單選、多選題型的細部 validation 還需要真正 PHP switch 內容才能做到逐型等價。這是 validation 深度的下一批，不影響 14 種題型的存取與 API 基礎形狀。
