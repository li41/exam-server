# 院內題庫的擁有者收窄：「只看自己建的」

Issue：`#101 WO-SERVER-QBANK-OWN-SCOPE`　日期：2026-08-21　基準：`origin/main` = `24e8891`

前一輪的稽核（`doc/question-bank-authz-gap-audit.md`）依 `#98` 的保險條款停手回報，
主公 **2026-08-21 裁示走丙**：題庫收窄成「只看自己建的」，而**權限由院內自己管**，
⛔ 不依賴客戶端自稱、⛔ 不反向連回 CF。理由是院內是獨立的信任邊界，讓它自足。

⚠️ 丙案的已知代價（裁示時已認可、**這張單不解決**）：權限有兩個地方（CF 與院內）
可能不一致，後續以「CF 畫面同時顯示兩邊設定」處理。

---

## 1. 一句話行為

| 帳號的 `roles`                           | 題目可見範圍               | 對照 PHP                                                |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------- |
| 含 `questions_all`                       | 本租戶**全部**題目         | `canViewAllQuestions()` 為真                            |
| 含 `questions_own`、不含 `questions_all` | 只有 `created_by` 是自己的 | `canOperateQuestion()` ⇒ `created_by === $userId`       |
| 兩者都有                                 | 全部（`questions_all` 勝） | 同上；PHP 的成員畫面把兩者做成互斥（`membersView.php`） |
| 🔴 兩者都沒有                            | **全部**（今天所有帳號）   | ⚠️ PHP 是 **403 完全不能進題庫**                        |

最後一列是**刻意的登記偏離**。理由：院內今天所有帳號的 `roles` 都不含這兩個值
（實測：`rg 'questions_own|questions_all'` 在 `24e8891` 的原始碼零命中；
部署腳本的預設就是 `developer`，`deploy/scripts/bootstrap-almalinux10.sh:56`
`SF_ADMIN_ROLES="${SF_ADMIN_ROLES:-developer}"`），
照 PHP 做會讓**所有現存使用者一次全部看不到題目**。
⇒ 收窄是**選擇性加上去**的，預設維持今天的行為。
⛔ 不要「為了和 PHP 一致」把預設改成只看自己或 403。

唯一的判斷處：`packages/domain/src/use-cases/question-visibility.ts`
的 `visibleQuestionOwnerIdFor()`；唯一的注入處：`apps/api/src/question-bank-routes.ts`
的 `scopeFor()`。

## 2. 兩條要自己決定的路，以及選了哪一條

### A. 權限放哪裡 ⇒ **甲式：讓既有的 `roles` 真的有牙齒。⛔ 沒有動 schema、沒有新 migration。**

|                                | 甲式（選了這個）                                                                                                    | 乙式（`users` 加欄位、migration `016`） |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| schema 變更                    | **無**                                                                                                              | `ALTER TABLE users ADD COLUMN …`        |
| 「既有帳號行為完全相同」怎麼證 | 既有帳號的 `roles` 不含那兩個值 ⇒ 走上表最後一列 ⇒ 同今天。**不需要 migration，所以沒有「migration 之後」這個時點** | 要證 `NULL` 預設被讀成「看全部」        |
| N-1 相容                       | **無條件成立**（沒有 schema 差異）                                                                                  | 靠 `015` 的形狀（可加欄位）             |
| 授予方式                       | `scripts/create-user.mjs --roles`（`:41-65` 已支援、已有測試）                                                      | 需要新的寫入路徑                        |
| 風險                           | `roles` 本來是惰性欄位（只出現在 login 回應與 audit log），現在有行為                                               | 多一張表欄位與一次 migration            |

選甲式的決定性理由是第二列：**要求 1「migration 之後所有現存帳號行為必須與今天完全相同」，
在沒有 migration 的做法下是恆真的**，不需要靠測試去證明一個資料轉換沒出錯。
`--roles` 的驗證規則本來就是自由字串（`create-user.mjs:58-62` 只管「至少一個」與「≤100 字」），
⛔ 沒有白名單要改。

⚠️ 甲式的代價要寫下來：`roles` 從此**不再是惰性欄位**。
`doc/question-bank-authz-gap-audit.md:90` 逐字寫著「`roles` 有被拿來授權嗎 ⇒ **零**」——
那一句從本單起為假，已在該文件就地更正。

### B. 命名 ⇒ **沿用 PHP 的 `questions_all`／`questions_own`**

理由：跨系統對照時同名最省事，而語意也真的相同（都是「可看全部」對「只看自己建的」）。
差異只在**掛在哪一層**：

|                  | PHP                                       | 院內                                   |
| ---------------- | ----------------------------------------- | -------------------------------------- |
| 掛在             | `company_members.permissions`（公司成員） | `users.roles`（帳號）                  |
| 粒度             | 一人一筆成員資料                          | **一人一帳號**（主公 2026-08-21 確認） |
| 沒有這兩個權限時 | 403                                       | 看全部（見第 1 節）                    |

⚠️ 院內是「帳號層」，PHP 是「成員層」——因為院內帳號一人一組，兩者實際指向同一個人。
⛔ 若哪天院內改成一台一組（共用帳號），這個收窄會變成「同機同事互相藏題」而不是保護，
**必須先重新裁示**再繼續用。

## 3. 收窄真正套在哪裡（與刻意不套的地方）

吃 `QuestionOwnerScope`（＝真的收窄）：

| 路徑                                | 實作                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /questions`（含 `page.total`） | `questionFilterPredicates()` —— 列表與 `COUNT(*)` 共用同一組 WHERE ⇒ 不可能一邊收窄一邊沒有                  |
| `GET /questions/stats`              | `questionStats()`                                                                                            |
| `GET /questions/:id`                | `getQuestionWith()` ⇒ 回 `null` ⇒ **404**，⛔ 不是 403（403 會洩漏「這個 id 存在」）                         |
| `PATCH /questions/:id`              | `UPDATE … AND (? IS NULL OR created_by = ?)`，且判斷 404／409 的 `throwQuestionUpdateFailure()` **也帶收窄** |
| `DELETE /questions/:id`             | 同上                                                                                                         |

⛔ **刻意不收窄**的四類（每一處都用 `unnarrowedQuestionScope()` 標記，
`rg "unnarrowedQuestionScope"` 一次列得完）：

1. **建立後的 read-back**（`createQuestion`）：那一列 `created_by` 就是自己，
   收窄只可能造成「建立成功卻讀不回來」。
2. **唯一性檢查**（匯入的 `findExistingQuestionCodes`）：題目 code 在**租戶內**唯一。
   收窄會讓人看不到別人佔用的 code，然後撞資料庫的 duplicate error ⇒ 訊息更難懂，而且擋不住。
3. **「還有東西在引用它嗎」**（`isFileReferenced`、分類刪除的引用計數）：
   收窄會讓「只看自己」的人**刪掉別人正在用的檔案／分類**。
   ⇒ 收窄可見範圍是為了少看到東西，不是為了多刪得掉東西。這兩處各有一案測試釘住。
4. **題組／題本這一族**（下一節）。

租戶隔離（`tenant_id`）⛔ 一個字都沒動；本單只在它之下再加一層。

## 4. 🔴 登記：本單**沒有**收窄的範圍

**「只看自己建的」這句話，在本單之後對題目為真，對題組／題本仍為假。**

| 實體                          | 院內現況  | PHP                                                                                              | 量到的成本                 |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------ | -------------------------- |
| `question-clusters`（題組）   | ⛔ 不收窄 | 收窄（`ClusterActions.php` 8 個 handler 有 6 個呼叫 `canOperateQuestion()`；清單走 `$onlyMine`） | MySQL 端 9 處 SQL          |
| `question-groups`（題群）     | ⛔ 不收窄 | 收窄（`GroupActions.php`；但 `doSearchClusters:488` 自己也沒守）                                 | 同上（合計 9 處含 groups） |
| `test-booklets`（題本）       | ⛔ 不收窄 | 收窄（`BookletActions.php`；但 `doSearchBookletItems:518` 自己也沒守）                           | MySQL 端 6 處 SQL          |
| 「題組可以引用誰的題目」      | ⛔ 不限制 | 限制（`Actions.php:265-284` `filterValidQuestionIds()`）                                         | 另 4 處跨實體閘門          |
| `question-categories`（分類） | 不收窄    | **PHP 也不收窄**（表上沒有 `created_by`）                                                        | ——（不該做）               |

為什麼本單不做：

- 這張單的六案驗收判準逐案都是題目，⇒ 做進去是「不得多」的那一邊。
- **不會因此洩漏他人題目內容**：實查 `QuestionClusterItemSchema:17-21`、
  `QuestionGroupItemSchema:124-127`、`TestBookletItemSchema:12-16` 與三支 repository 的
  `SELECT` 欄位 —— 題組／題本回的**只有 questionId／groupId 與 available 布林**，
  ⛔ 沒有任何題幹文字。`questions` 表只被 JOIN 用來判存在。
  （⚠️ 對照 PHP：PHP 的搜尋類 handler **會**回 `stem_preview`，見 `ClusterActions.php:379`。）
- 院內側的桌面程式今天**還沒有**題組／題本頁面（見
  `exam-admin-desktop/docs/question-bank-php-parity-gap-2026-08-21.md` 的 A-1），
  ⇒ 目前的暴露面只有直打 API。

⇒ 建議另開一張單，並且**連 PHP 自己漏掉的那兩支搜尋 handler 一起裁**。

其他登記（本單⛔不動手）：

- **desktop**：`ExamServerQuestion*` 一族今天沒有任何「你只看得到自己的題目」的提示，
  被收窄的帳號會看到一個「看起來就是空題庫」的畫面。⇒ 由樊長玉另開單。
- **沒有 CLI 可以改既有帳號的權限**：`create-user.mjs` 只能建立。既有帳號要授予收窄，
  今天的操作程序是直接改資料（見下節）。⇒ 要不要做一支 `set-user-roles` 屬另一張單。
- `AuthIdentity.roles` 仍然是自由字串、沒有白名單 ⇒ 打錯字（例如 `question_own`）
  的後果是**靜默地不收窄**。第 5 節的測試有一案釘住「相近字串不會誤觸」，
  但⛔ 沒有任何機制能告訴操作者他打錯了。

## 5. 驗收：鑑別力

`apps/api/test/question-bank-owner-scope.test.ts`（檔案 sha256
`10098c76d0f7020cf41260d1448dbaea48c7308f8f57fafab28c86ce7e0c96d5`）
**原封不動**（同一顆 sha256）複製到改動前的樹（`24e8891` 的 detached worktree），
跑 `vitest run`：

```
Tests  7 failed | 7 passed (14)
```

紅的 7 案（＝收窄本體）：案 1 清單／案 2 單筆 404／案 3 改刪不動且資料未被動到／
案 3b 錯 version 回 404 不是 409／案 4 統計＋與清單 total 一致／
案 4b `?createdBy=` 繞不過／repository 層縱深防禦。

綠的 7 案是**刻意**的：案 5（`questions_all` 照舊看全部）、案 6（既有帳號行為不變）、
案 7（自己新建的看得到）、案 8（租戶隔離）、repository 層的反向對照、
以及兩案「⛔ 不得過度收窄」（不得刪別人正在用的檔案／分類）。
它們斷言的是「**這些行為不准變**」⇒ 在舊樹上本來就該綠，
這正是「紅來自收窄、不是來自把 harness 弄壞」的證據。

⚠️ 這一支刻意**不 import** 新的常數，角色名寫成字面值 `"questions_own"`，
所以它在舊樹上**載得起來**、紅在行為而不是紅在「符號不存在」。
常數與對照表本身在 `apps/api/test/question-visibility.test.ts`
（那一支 import 新符號 ⇒ ⚠️ **不構成鑑別力證據**，本文件不拿它當證據）。

### 反向突變（每一條守門都要能紅）

13 發，12 紅、**1 發刻意留綠**（M13，理由見下）：

| #   | 突變                                            | 結果                                  |
| --- | ----------------------------------------------- | ------------------------------------- |
| M1  | `questions_own` 也回 `null`（收窄整條失效）     | 紅 7 案                               |
| M2  | `questions_all` 也只看自己（過度收窄）          | 紅 5 案                               |
| M3  | 沒有題庫角色的既有帳號變成只看自己              | 紅 3 案                               |
| M4  | 角色名改成前綴比對（`questions_ownx` 也被收窄） | 紅 1 案                               |
| M5  | 清單少了收窄（`total` 一起錯）                  | 紅 3 案                               |
| M6  | 單筆讀取少了收窄（物件級守門失效）              | 紅 1 案                               |
| M7  | repository 的改／刪少了收窄                     | 🔴 **第一輪假綠**，補案後紅 1 案      |
| M8  | 統計少了收窄                                    | 紅 2 案                               |
| M9  | `scopeFor()` 寫死 `null`（route 沒接上）        | 紅 6 案                               |
| M10 | `isFileReferenced()` 也收窄（過度收窄）         | 紅 1 案                               |
| M11 | 分類刪除的引用計數也收窄（過度收窄）            | 紅 1 案                               |
| M12 | `unnarrowedQuestionScope()` 其實會收窄          | 紅 2 案                               |
| M13 | **MySQL 的 `ownerPredicate()` 整條失效**        | ⚠️ **綠——沒有任何執行到的測試抓得到** |

🔴 **M7 是第一輪假綠，要記下來為什麼**：`QuestionBankService.updateQuestion()`
會先 `getQuestion()`，所以走 HTTP 時永遠在讀那一步就 404 了
⇒ 只測 route 的話，repository 自己那條 `UPDATE … AND created_by = ?`
**整條拿掉都不會有測試變紅**。已補「直接打 repository」那一組案子（含反向對照）才轉紅。

🔴 **M13 是誠實的覆蓋邊界，不是漏做**：把 MySQL 版的 `ownerPredicate()`
改成恆真，全部 20 個 API 測試仍然綠——因為 API 測試用的是 in-memory repository。
真正的 SQL 只有 `packages/adapters/mysql/test/question-bank-repository.integration.test.ts`
（本輪新增一案）覆蓋，而它需要 `MYSQL_TEST_URL`，
⚠️ **本輪未執行**（本機沒有那個環境變數，而執行 migration 在紅線內）。
⇒ 「MySQL 端的收窄真的生效」目前只有**型別＋逐行對照 in-memory 版的語意**，
⛔ 沒有跑過的證據。

🔴 順手抓到的靜默陷阱：`packages/adapters/mysql` 的 `tsconfig.json` 只
`include: ["src"]` ⇒ **該 package 的測試檔完全不過型別檢查**。
`QuestionOwnerScope` 多一格必填欄位時，那些手寫的 scope 字面值不會有編譯錯誤，
而是等到有 `MYSQL_TEST_URL` 時才炸在 mysql2 的
「Bind parameters must not contain undefined」。本輪已就地補齊並在檔案裡寫下原因。

## 6. N-1 migration rollback（`doc/nminus1-migration-rollback.md`）

**本單沒有 schema 變更、沒有新 migration**（甲式）⇒ 那份文件描述的「只回滾程式、
不回滾資料庫」情境在本單是**恆真**的：N-1 的程式讀到 `users.roles` 裡多一個字串
會直接忽略它（`parseRoles()` 只驗「是字串陣列」，`user-repository.ts:34-38`）。

🔴 但要把後果寫清楚，因為它是安全屬性而不是資料屬性：
**回滾到 N-1 之後，收窄會消失**（那個帳號恢復看得到全部題目），
⛔ 不是資料損毀、也不會有錯誤訊息 —— 是靜默地 fail-open。
⚠️ 乙式（加欄位）**有完全相同的性質**，所以這不是選甲式造成的。
⇒ 若哪天有帳號真的被授予 `questions_own`，回滾程式版本前必須知道這一條。

## 7. 操作程序：怎麼授予「只看自己」

新帳號：

```bash
node scripts/create-user.mjs --email her@example.com --tenant <uuid> \
  --roles developer,questions_own --name 王小明
```

既有帳號（⚠️ 今天沒有 CLI，見第 4 節的登記；`roles` 是 JSON 陣列）：

```sql
-- 先看現況
SELECT id, email, roles FROM users WHERE email = 'her@example.com';
-- 加上收窄（⚠️ 重複執行會塞第二個相同值，先確認上面的結果）
UPDATE users SET roles = JSON_ARRAY_APPEND(roles, '$', 'questions_own')
 WHERE email = 'her@example.com';
```

🔴 改完必須**重新登入**才生效，⛔ 換發 refresh token 沒有用：
`AuthService.authenticate()` 回的是 `session.identity`（`packages/auth/src/service.ts:115-123`），
而那個 identity 是 **login 當下**對 `users` 表的快照（`:129-135` `toIdentity(user)`）；
`rotate()` 也只是搬同一份 identity。⇒ 舊 session 沒過期前，收窄不會生效。
⚠️ 這一條同樣適用於**取消**收窄：改回去之後，那個人要重新登入才會恢復看全部。
