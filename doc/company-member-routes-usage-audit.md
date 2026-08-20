# Company member routes usage audit

Issue: `#93 WO-COMPANY-MEMBER-WHO-USES-IT`

日期：2026-08-20

## 結論

**甲：在本工單指定的程式庫與部署資產中，找不到 production caller，建議下一張工單刪除 `exam-server` 這組 company-member 路由與其專用支援層，而不是繼續補 #80 列出的六條 PHP parity gap。**

這個結論只回答「目前 repo 內可追到的 consumer 是誰」。它不把靜態稽核包裝成網路流量證明；若有未納管、未進 repo 的外部 client，單靠 source tree 無法證明其不存在。但在 #93 指定要排除的五類來源中，沒有找到任何 production consumer。

本文件直接承接 #93 工單已量到的五條前置事實，不重做那五條掃描：CF CONTROL_DB 自初始 schema 就有 `company_members`、CF 有成員管理路由、桌面版成員頁走 CF client、桌面版 `src/api` 沒有 member client 指向 `exam-server`、以及 `company-member-routes.ts` 在 `exam-server` 只由 `server.ts` 掛載一次。

## 調查方法與限制

本輪只查不改 production code。調查依 #93 指定的五個來源往下排除，並把「測試用」與「production wiring」分開。

GitHub connector 的 code-search index 在這個 repo 對已知存在的 `/company-members` literal 也曾回零結果，因此「搜尋零命中」不能單獨當不存在證據。凡是重要的否定結論，下面都搭配已知入口、完整 tree 或代表性網路／部署檔案人工檢查；查不到時也明列試過什麼。

格式化狀態：**Prettier 沒跑**。前一輪嘗試 Corepack 時，環境解析 `registry.npmjs.org` 失敗（`getaddrinfo EAI_AGAIN`）；依 #93 最新修正留言，本輪明確不要再跑 Prettier，由收件端處理排版。`corepack pnpm verify` 也依工單指示沒有執行。

---

## 1. `exam-server` 內部還有誰用 company-member use-case / repository？

### 事實

Production wiring 是一條封閉鏈：

- API process 有 `MYSQL_URL` 時建立 MySQL pool：`apps/api/src/server.ts:68`。
- `companyMemberRepository` 只在啟動 wiring 選擇 MySQL 或 in-memory implementation：`apps/api/src/server.ts:115-117`。
- 這個 repository 被交給 `mountCompanyMemberRoutes(...)`：`apps/api/src/server.ts:234-240`。
- route 內以該 repository 建立 `CompanyMemberService`：`apps/api/src/company-member-routes.ts:99`。
- 只有 `/company-members` 的 GET / POST / PATCH handler 呼叫這個 service：`apps/api/src/company-member-routes.ts:232-268`；再掛到 legacy `/api` 與 versioned `/api/v1` prefix：`apps/api/src/company-member-routes.ts:273-279`。
- `CompanyMemberService` 的 list/get/create/update 會讀寫同一個 repository，且 manager gate 也只保護這組 member operation：`packages/domain/src/use-cases/company-members.ts:287-382`。

#93 最新留言另已複驗 production source grep：排除 tests 與 self-reference 後，`CompanyMemberRepository|companyMemberRepository` 只落在 `apps/api/src/server.ts:17,38,115-117,234` 這條 wiring；沒有其他 middleware／授權守門讀這個 repository。舊的 mapping 文件也明載：建立這條 member data path 時，**沒有**把 desktop 或其他 resource authorization flow 切過來，question/examinee 等既有路由不查這張表：`doc/company-members-php-mapping.md:5`。

測試確實在用，但它們不是 production consumer：

- API route test 直接 import `mountCompanyMemberRoutes`：`apps/api/test/company-members.test.ts:16`。
- MySQL integration test 直接建立 `MySqlCompanyMemberRepository`：`packages/adapters/mysql/test/company-member-repository.integration.test.ts:9-21`。

Barrel export 也存在，但只是 export surface，不是 runtime consumer：`packages/domain/src/index.ts:13,26`、`packages/adapters/mysql/src/index.ts:2`、`packages/testing/src/index.ts:7`。

### 現行影響

目前看不到 company-member repository 被拿去做其他 API 的授權、middleware 或 shared policy。也就是說，這張 MySQL member table 並沒有在背後影響 question bank、examinee、affair 等其他 production flow；它的 production 影響面被限制在這組 member routes 本身。

### 潛在影響

只要有人開始呼叫這組 routes，這個封閉鏈就會立即變成第二條可寫的成員資料路徑；第 5 節說明它寫的是 `exam-server` MySQL，不是 CF CONTROL_DB。

---

## 2. PHP `exam.tw` 有沒有打這組 `exam-server` endpoint？

### 事實

**找不到。** 我試了：

1. 在 `li41/exam.tw` 搜尋 literal `/api/company-members`：零命中。
2. 搜尋 literal `/api/v1/company-members`：零命中。
3. 沿 PHP 成員管理的實際寫入入口反查：AJAX handler 直接呼叫 PHP model 的 `CompanyMember::inviteMember(...)`，不是 HTTP client：`src/Pages/Ajax/MemberActions.php:43-48`。
4. PHP model 自己取得 PHP database handle：`src/Models/CompanyMember.php:116`，並直接 `$db->insert('company_members', ...)`：`src/Models/CompanyMember.php:142-151`。
5. model 綁定的 table 就是 PHP 自己的 `company_members`：`src/Models/CompanyMember.php:16`。

### 現行影響

PHP 的成員管理不是這組 `exam-server` routes 的 consumer。PHP UI 的新增／審核／更新流程有自己的 model + database path，所以不能拿「PHP 頁面有成員管理」當作保留 `exam-server` member routes 的理由。

### 潛在影響

若未來把 PHP flow 改成打 `exam-server`，才會把第 5 節的 MySQL 第二資料源啟用；本輪沒有找到現在已經這樣做的證據。

---

## 3. `exam-runtime` 有沒有用這組 endpoint？

### 事實

**找不到。** 我試了：

1. 在 `li41/exam-runtime` 搜尋 `company-members`：零命中。
2. 搜尋 `CompanyMember`：零命中。
3. 搜尋 `exam-server`：零命中。
4. 再搜完整 literal `/api/company-members` 與 `/api/v1/company-members`：零命中。
5. 檢查 runtime 的公開／RPC 邊界：`src/index.ts` 明確說舊的公開 `/api/deploy/*` 仍給 PHP 使用，並 export `RuntimeControlApi` 給 `exam-control` 的 Service Binding：`src/index.ts:53-55`；RPC env 與 entrypoint 處理的是 runtime KV/D1/DO 與 deployment control：`src/rpc/RuntimeControlApi.ts:48-74`。這些邊界沒有 company-member client。

### 現行影響

`exam-runtime` 不是 `exam-server` company-member routes 的 consumer；runtime 的 control plane integration 是 `exam-control -> RuntimeControlApi`，與這組 member routes 無關。

### 潛在影響

未發現 runtime 會因刪除這組 member routes 而失去既有功能的 source-level dependency。

---

## 4. deploy / doc / scripts 有沒有 URL、curl 或操作流程在用？

### 事實

**找不到 production caller。** 我試了：

- 先看 `exam-server` 完整 repository tree，確認部署資產集中在 `deploy/`、操作腳本集中在 `scripts/`，並逐一檢查有明確 HTTP 行為的代表檔案。
- release installer 的 server probe 只有 `http://127.0.0.1:8787/health/ready`：`deploy/scripts/install-release.sh:15`；實際 curl 也只打該 `health_url`：`deploy/scripts/install-release.sh:83-90`。
- outage heartbeat 由 server env 組出的本機 URL也是 `/health/ready`：`scripts/outage-heartbeat.mjs:77-83`；其外部 HTTP 是送 healthchecks heartbeat，不是 member API。
- Caddy 只是把外部 request reverse proxy 到 Node listener，不是主動 consumer：`deploy/caddy/Caddyfile.example:15-17`。
- `doc/` **有描述** member endpoints，例如 parity review 比較 `GET /company-members`、`POST /company-members` 等：`doc/company-members-php-parity-review.md:38-45`。這是 API 文件／稽核材料，不是會發 request 的 caller。
- 更早的 mapping 文件反而直接記錄當時沒有切 desktop 或其他 authorization flow 到這條 member data path：`doc/company-members-php-mapping.md:5`。
- `scripts/runtime-export-smoke.mjs` 只 import internal package root 做 export smoke test：`scripts/runtime-export-smoke.mjs:111-148`，不是 HTTP consumer。

我也嘗試用 GitHub code search 搜 `/company-members`，但 connector index 對已知存在的 route source 也回過零結果，因此沒有把該搜尋結果當作證明；以上否定結論是以 tree + 具網路行為的部署／操作檔人工檢查為主。

### 現行影響

沒有部署、健康檢查、維運腳本或 runtime smoke flow 依賴 member endpoint。`doc/` 中看到 endpoint 名稱只能證明「有人文件化它」，不能證明「有人呼叫它」。

### 潛在影響

刪路由時應同步更新／標記舊 mapping 與 parity review，避免歷史文件讓後來的人誤以為這仍是建議整合面。

---

## 5. 這組路由實際讀寫哪個資料庫、哪張表？

### 事實

這組 `exam-server` route 在 production wiring 下讀寫的是 **`MYSQL_URL` 指向的 exam-server MySQL**，表名是 **`company_members`**：

- process 用 `config.mysqlUrl` 建 MySQL pool：`apps/api/src/server.ts:68`。
- pool 存在時 company member repository 使用 `MySqlCompanyMemberRepository(pool)`：`apps/api/src/server.ts:115-117`。
- MySQL schema 自己建立 `company_members`：`packages/adapters/mysql/schema/014_company_members.sql:1-26`。
- adapter list 直接 `FROM company_members`：`packages/adapters/mysql/src/company-member-repository.ts:152-158`；get/find 也直接讀同表：`packages/adapters/mysql/src/company-member-repository.ts:166-185`。
- create 直接 `INSERT INTO company_members`：`packages/adapters/mysql/src/company-member-repository.ts:198-218`；同一 repository 的 update/count 等操作也以此表為 target。

另一方面，工單既定事實中的 CF CONTROL_DB 也有自己的 `company_members`，而且就在初始 schema：`exam-control/migrations/0001_initial_control_schema.sql:77-91`。

這兩個 schema 不是同一張表：CF 是 SQLite/D1-style control schema（`company_id`、integer ids、`permissions_json`），`exam-server` 是 MySQL schema（`tenant_id`、UUID-like CHAR ids、JSON `permissions`、review/version 欄位）。

### 現行影響

**不要把這件事寫成「現在有兩份成員資料正在分歧」。**

目前可確認的狀態是：

- CF 那一側是工單已確認的桌面版實際成員管理路徑。
- MySQL 那一側在 production code 中有完整 schema + repository + route wiring，但本次五類 consumer 掃描找不到 route 的 production caller。
- `doc/company-members-php-mapping.md:5` 也明確記錄沒有把其他 resource authorization flow 切到這張表。

因此本輪能支持的是「**一份活的 CF 路徑 + 一份目前只服務這組無 caller route 的 MySQL 資料模型**」。沒有證據支持「兩邊現在正被同時寫入」或「目前已發生資料漂移事故」。

### 潛在影響

這仍然是本工單最需要處理的架構風險：如果任何新 client 開始使用 `exam-server` member routes，寫入就會落到 MySQL `company_members`，而桌面版繼續使用 CF CONTROL_DB `company_members`。那一刻才會真正出現兩個獨立 writable truth source，且兩邊沒有同步／交易／一致性機制。

另有一個會把「潛在」推向「實際」的訊號：server 啟動時的 structured log 固定宣告 `companyMembers: "enabled"`：`apps/api/src/server.ts:294-307`。這不是 HTTP capability-discovery endpoint，而是 operation/observability 層的能力宣告；但它會讓維運者或後續整合者合理地把 company-member 能力視為正式啟用。若路由其實沒有合法 consumer，這個旗標應和路由一起移除，避免邀請新依賴。

---

## 現行影響總結

1. 在 #93 指定要檢查的 `exam-server` internal、PHP、`exam-runtime`、deploy/doc/scripts 五類來源中，找不到 production caller。
2. 現有 `exam-server` MySQL `company_members` 沒有被其他 resource authorization flow 使用；其 production reachable surface 是這組 member routes 自己。
3. 桌面版目前使用 CF member path，因此本輪沒有證據顯示 CF 與 MySQL 兩份 member table 正在被同時寫入或已經資料分歧。
4. #80 的六條 parity gap 描述的是一條目前沒有找到 consumer 的 server API 與 PHP 的差異，**不應直接轉成修復 backlog**。

## 潛在影響總結

1. `exam-server` 已經具備可寫的 MySQL member schema、repository 與 HTTP routes；任何新 consumer 都可能在不知情下建立第二個 active truth source。
2. `server_started` log 又把 `companyMembers` 固定標成 `enabled`（`apps/api/src/server.ts:294-307`），增加未來有人把它當正式 integration surface 的機率。
3. 若先花工修 #80 六條 gap，等於把一條沒有 caller、且資料 authority 位於 CF 的旁路做得更完整，反而增加被採用與產生雙寫真相源的風險。

## 建議

### 決策：甲——刪，不修六條 gap

下一張刪除工單應以「移除這條未使用 integration surface」為目標；在那之前不要修 #80 六條 gap。

建議刪除的 feature-specific 檔案：

- `apps/api/src/company-member-routes.ts`
- `apps/api/test/company-members.test.ts`
- `packages/domain/src/use-cases/company-members.ts`
- `packages/domain/src/ports/company-member-repository.ts`
- `packages/adapters/mysql/src/company-member-repository.ts`
- `packages/adapters/mysql/test/company-member-repository.integration.test.ts`
- `packages/testing/src/fake-company-member-repository.ts`
- `packages/api-contracts/src/company-members.ts`

建議同步修改、移除 member wiring/export 的檔案：

- `apps/api/src/server.ts`：移除 MySQL/in-memory repository wiring、`mountCompanyMemberRoutes(...)` 與 `companyMembers: "enabled"`。
- `packages/domain/src/index.ts:13,26`：移除 member port/use-case exports。
- `packages/adapters/mysql/src/index.ts:2`：移除 MySQL member repository export。
- `packages/testing/src/index.ts:7`：移除 fake member repository export。
- `packages/api-contracts/src/index.ts:333-340`：移除 `company-members.js` export。
- 舊的 `doc/company-members-php-mapping.md`、`doc/company-members-php-parity-review.md`：保留作歷史證據或標記 superseded，但不要再把其中六條 gap 當 active server backlog。

MySQL schema 不建議直接刪掉既有的 `packages/adapters/mysql/schema/014_company_members.sql` 歷史 migration。下一張工單應先檢查 production MySQL 這張表是否已有資料，再依本 repo forward-only migration 規則決定是否新增 drop-table migration；在確認之前，不應倒改 migration 歷史。

## 驗收狀態

- 本工單只新增這一份 audit markdown；沒有修改任何 `.ts`、route、use-case 或 repository source。
- `corepack pnpm verify`：**未執行**，依 #93 明確指示。
- Prettier：**未執行**；先前環境因 Corepack 連 `registry.npmjs.org` DNS `EAI_AGAIN` 無法取得 pnpm，且 #93 最新留言明確授權本輪不要再跑，由收件端排版。
