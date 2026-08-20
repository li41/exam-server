# 院內題庫的擁有者權限缺口：稽核與停手回報

Issue：`#98 WO-SERVER-QBANK-AUTHZ-AND-STATS` 的 ①（A-7）

日期：2026-08-21　　基準：`origin/main` = `f1eb42c`

## 結論：**不動手，回報裁示。**

`#98` 工單自己寫了一條保險：

> 如果你查到「院內 API 刻意不做權限區分」的明文裁決 ⇒ 停下來回報那條裁決，⛔ 不要動手。

**那條裁決存在，而且不只一條。** 下面三格各自獨立成立；任何一格都足以讓「補上
`questions_own` 收窄」從「修一個缺陷」變成「改一個既有的設計決定」。

⚠️ 這份文件**不主張現況是對的**。PHP 那側確實有逐筆的擁有者守門（第 4 節逐條列出），
院內這側沒有，兩者的差距是真的。這裡只主張：**這個差距是被寫下來的選擇，不是被忘記的疏漏**，
所以要不要抹平它屬裁量，不屬實作。

---

## 1. 明文裁決一：題庫的設計文件逐字寫「`createdBy` 不是隔離鍵」

`doc/question-bank-php-mapping.md:46`，逐字：

> 同公司使用者可看到彼此題目；`createdBy` 是建立者稽核欄位，**不是私人資料隔離鍵**。

⚠️ 這句不是隨手寫的旁白：同一份文件第 3 行自陳它記錄的就是
「資料模型來源、exam-server 實作選擇，以及**刻意不照抄 PHP 的地方**」。
⇒ 這句話所在的位置，正是這個 repo 用來登記「刻意偏離 PHP」的地方。

`git log -L` 顯示它是**題庫領域第一顆實作 commit**（`5ba6395 Implement question bank domain`）
就寫下的，之後只被 `4a11245` 動過標點，語意沒變。⇒ 不是後來補的辯解。

## 2. 明文裁決二：授權流程被**指名**留在 `exam-control`

`doc/company-members-php-mapping.md:5`，逐字（英文原文）：

> This change builds the company-member and permission data path inside `exam-server`
> **without switching the desktop or any existing resource authorization flow away from
> `exam-control`**. … **no existing question/examinee/etc. route is changed to consult this table.**

⇒ 「題庫路由不查權限表」是當時明講的範圍界線。

## 3. 硬事實：那個權限模型**今天已經不在這個 repo 裡了**

🔴 `#98` 工單寫「把**已定義的** `questions_all`／`questions_own` 真的接到題庫路由上」——
**這句在今天的 `origin/main` 上不成立。**

`f1eb42c`（PR `#96`，2026-08-20 併入）刪掉了整組 company-member 實作。實查 `f1eb42c`：

```
rg 'questions_all|questions_own' --glob '!dist' --glob '!*.md' .   ⇒ 零命中
```

`packages/api-contracts/src/company-members.ts`、`packages/domain/src/use-cases/company-members.ts`、
`apps/api/src/company-member-routes.ts` 皆已不存在。刪除的依據是
`doc/company-member-routes-usage-audit.md:9` 的「決策：甲——刪，不修六條 gap」，
其理由第 149 行逐字：「CF 那一側是工單已確認的桌面版實際成員管理路徑」。

⇒ 今天要在院內側做 `questions_own`，**必須先把一個昨天才依裁示刪掉的權限模型重新建回來**。
那顯然不是一張實作單能自己決定的事。

## 4. 誠實邊界：PHP 那側確實有守門，而且是逐筆的

不能因為第 1–3 節就說「院內不需要」。PHP 的實際行為（真相源 `exam.tw`）：

| 面向                 | PHP 行為                                                                                                       | 座標                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 權限鍵與互斥         | `questions_all` / `questions_own` 互斥，admin 恆為 all                                                         | `src/Models/CompanyMember.php:44-45,74-76,78-80`                                               |
| 「能看全部嗎」       | `isAdmin() \|\| questions_all`                                                                                 | `src/Models/CompanyMember.php:441-444`                                                         |
| 列表收窄             | 呼叫端 derive `$onlyMine`，model 加 `q.created_by = :cby`；`questions_own` 被硬鎖成 `mine`，`?view=all` 逃不掉 | `src/Pages/Manage/Traits/QuestionActions.php:37-47`、`src/Models/Question.php:851-854`         |
| 單筆檢視／編輯       | model 只比 company，**controller 逐筆補 owner 檢查**                                                           | `src/Pages/Manage/Traits/QuestionActions.php:118-130,161-172`                                  |
| 編輯／刪除／啟用停用 | `canOperateQuestion()`，不合回 403                                                                             | `src/Pages/Ajax/Actions.php:226-230`、`src/Pages/Ajax/QuestionActions.php:155-158,280-283,322` |
| 統計卡               | 逐題型計數吃同一個 `$onlyMine`                                                                                 | `src/Models/Question.php:926-935`、`src/Pages/Manage/Traits/QuestionActions.php:70`            |

⇒ 差距是真的。**院內側今天：同租戶任何已通過驗證的呼叫方可讀寫該租戶全部題目。**

## 5. 🔴 為什麼「照抄 CF 的形狀」在這裡接不起來

`#98` 建議照 `exam-control/src/db/question-clusters.ts` 的 `visibleQuestionOwnerId`。
那個形狀能成立，是因為 CF 那側的 `ctx.user` 是**帶著權限表的 CF 登入使用者**。
院內這側不是：

| 問題                                 | 院內現況                                                                                        | 座標                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 呼叫端是誰                           | 只有桌面版一個                                                                                  | 桌面 `src/api/exam-server-client.ts:359-368`；`exam.tw` / `exam-runtime` / `exam-control` 均零命中 |
| 用什麼身分                           | 使用者在 App 內**另外輸入的一組 exam-server 帳密**，與 CF／Google 登入那個人**無任何對應**      | 桌面 `src/ui/ExamServerQuestionBankSession.tsx:190-243`（表單不預填 CF email）                     |
| 身分裡有權限嗎                       | `AuthIdentity` 只有 `userId/email/tenantId/roles`；`roles` 是任意字串，實際部署一律 `developer` | `packages/auth/src/service.ts:29-34`、`deploy/scripts/bootstrap-almalinux10.sh:56`                 |
| `roles` 有被拿來授權嗎               | **零**：全 repo 沒有 `requireRole`／`hasRole`／`roles.includes`                                 | 只出現在 login 回應與 audit log                                                                    |
| CF 的 `questions_all/own` 傳得過來嗎 | **傳不過來**，桌面沒有任何欄位送出它                                                            | 桌面 client 送出的只有 query filter                                                                |

🔴 也就是說：**院內側今天沒有「這個呼叫方屬於哪一種權限」這個資訊**。
要做 A-7，得先決定「院內 exam-server 帳號是一人一組，還是一台一組」——
一台一組的話，`questions_own` 收窄不但沒有保護作用，還會把同機同事的題目互相藏起來。

⚠️ 這個 repo 已經有一次同型的裁示，結論寫在 `doc/decision-affair-belongs-to-cf.md`：

> 「沒有可信的 caller principal」…… **當一個「缺陷」的修法需要先決定使用者是誰，那它就不是缺陷。**

## 6. 要裁的其實是一個問題

**院內 `exam-server` 的帳號粒度是「一人一組」還是「一台／一單位一組」？**

- 若是**一人一組** ⇒ A-7 成立且該做：院內需要自己的權限來源（重建被 `#96` 刪掉的那層，
  或改由 CF 簽發帶權限的憑證），這是一張新的架構單。
- 若是**一台一組** ⇒ A-7 不成立：同一組帳號底下沒有「別人的題目」可言，
  該補的是別的東西（例如把「誰在這台機器上操作」記進 audit）。

## 7. 若裁定要做，正確的下刀處（先寫下來，免得下次又從 route 開始補）

⛔ 不要在各個 route 各自補 owner 判斷。PHP 那側就是逐 handler 手寫的，
於是漏了兩支：`exam.tw/docs/CODE-REVIEW-2026-07-08.md:88-91` 記著
「複製題組／題本繞過 `questions_own` 擁有權檢查」（`GroupActions.php doDuplicateGroup`、
`BookletActions.php doDuplicateBooklet` 只呼叫 `requireQuestionsPermission()`，
漏掉 `canOperateQuestion()`），判定 CONFIRMED。⇒ 逐點補的寫法會漏，別複製這個形狀。

✅ 正確位置是 `packages/domain/src/ports/question-bank-repository.ts` 的 `QuestionBankScope`
加一格（例如 `visibleQuestionOwnerId: string | null`），由 route 的 `scopeFor()` 依權限決定填 `null`
還是 `identity.userId`；列表、單筆讀取、更新、刪除、**以及本輪新增的統計**都吃同一個 scope
⇒ 加一格就全部一起收窄，不會漏掉某一條路徑。該型別的註解已經指向這裡。

## 8. 本輪實際做了什麼

- ①（A-7）：**只稽核、未動任何 production code。**
- ②（A-5 統計）：已做。統計走的就是第 7 節那個 scope，所以未來加收窄時會自動吃到。
- ③（A-6 建立者名稱）：見 `#98` 交件說明。
