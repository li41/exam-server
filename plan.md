# server-foundation 實作計畫

> 本文件於 `main@2c3bd872a9c007be7913c678eccf7cffb961a3ce` 重新複驗；off-site backup 狀態於 `main@a81f11fb58560fc61278b697ef10761614142c5f` 再次核對。判準不是「曾經規劃過」，而是 repo 或已記錄的實機／CI 證據能不能指出它真的存在。
>
> 第一個要服務真實使用者的目標，是**院內單一 VPS 的 `vps-mysql` profile，Windows 桌面後台經 WireGuard 存取**。Cloudflare 與 Google profile 是後續能力，不應混進第一批使用者的上線阻塞條件。

## 1. 目標與不變條件

`server-foundation` 要讓桌面 App 經由受保護的 API 使用後端資料與檔案服務，而不是直接持有 MySQL、D1、Sheets、Drive、Redis/Valkey 等 provider 憑證。

共同原則：

- 桌面端只呼叫 API，不直接連資料庫或雲端 provider。
- API contract、use case、權限與錯誤語意保持一致。
- provider 細節留在 adapter，不滲透到 route 或桌面 UI。
- 不提供沒有業務權限的任意資料表 CRUD。
- 檔案內容不放進 MySQL、D1 或 Sheets；資料庫只保存 metadata。
- 不假裝三種後端擁有相同的交易、搜尋、容量與併發能力。
- secret 只來自部署環境，不進 repo 或桌面 bundle。

目前規劃的 deployment profile：

- `vps-mysql`：Node API + MySQL + Redis/Valkey + private filesystem。**目前實作與上線工作的主線。**
- `cloudflare-d1-r2`：Cloudflare Workers + D1 + R2。尚未實作。
- `google-sheets-drive`：Google Sheets + Google Drive。尚未實作，定位為低併發／內部工具 profile。

## 2. 目前架構

```text
desktop-foundation
        │ API
        ▼
server-foundation
        ├── HTTP routes
        ├── authentication / authorization
        ├── use cases
        ├── audit / idempotency / error mapping
        └── provider ports
              ├── ItemRepository / other resource repositories
              ├── BlobStorage
              ├── SessionStore
              ├── IdempotencyStore
              └── ProviderCapabilities
```

目前 repo 中已落地的主要實作是 MySQL、Redis/Valkey protocol、local filesystem；D1/R2、Sheets/Drive 還沒有對應 adapter。

## 3. Phase 狀態：哪些做了、真正還缺什麼

### Phase 0：決策與契約 — 部分完成

不再宣稱整個 Phase 已完成。

已完成：

- API contract 與 v1 compatibility fixture：`packages/api-contracts/`、`contracts/api-v1.json`、`contracts/api-v1-fixtures.json`。
- domain ports 與 provider capability 型別：`packages/domain/src/ports/`。
- 第一個 fake repository：`packages/testing/src/fake-item-repository.ts`。
- contract fixture／compatibility gate 已進 `pnpm verify` 與 PR CI。

仍缺的具體交付：

- 原計畫要求的 ADR（provider 邊界、檔案生命週期、Google consistency、D1 migration）沒有形成 repo 內可查的 ADR 文件集。
- 原計畫要求的「可讓多個 provider 共跑的 provider contract test suite」尚未形成；目前 testing package 有 fake，但沒有一套能拿 MySQL、D1、Sheets adapter 逐一套用的共用 suite。

這兩項是架構治理缺口，不是目前 `vps-mysql` 第一批院內使用者的直接上線阻塞。在第二個真實 provider 開工前必須補，否則 provider 間語意容易漂移。

### Phase 1：Node API 核心 — 完成

證據：

- `apps/api/src/` 已有 API app、config、server、structured logger 與 graceful shutdown。
- `packages/domain/src/use-cases/items.ts` 與 MySQL/fake repository 已形成第一個業務垂直切片。
- auth、tenant isolation、request ID、audit、error mapping、health 都有實作與測試。
- `apps/api/test/` 包含 API、runtime hardening、observability、version/idempotency 等測試；`pnpm verify` 每次執行。

原 Phase 1 的「不接真資料庫也能用 fake adapter 測 API」仍成立，無需改成待辦。

### Phase 2：VPS + MySQL — 核心服務與乾淨機部署已完成

營運風險不再混寫成 Phase 2 功能缺口，統一列於 Phase 7。

已完成：

- MySQL schema／migration／repository／integration tests：`packages/adapters/mysql/`。
- version check、soft delete、cursor pagination、transaction、audit、durable idempotency 已落地。
- Redis session、logout、refresh rotation、login rate limit 與 Redis integration tests：`packages/adapters/redis/`、`packages/auth/`。
- **使用者建立流程已完成**：`scripts/create-user.mjs`，`pnpm verify` 會跑 `scripts/create-user.test.mjs`；AlmaLinux bootstrap 的步驟 13 也會用它建立第一個帳號。
- **乾淨 AlmaLinux 10 部署路徑已完成並經實跑修正**：`deploy/scripts/bootstrap-almalinux10.sh` 可從空機器做到資料庫、Valkey、WireGuard/firewalld、build/package/install、systemd health 與第一個帳號；完整安裝轉折可追 `c93042891cf363f29dd04cc1fd121043ef0799f0`，後續實跑又修掉 executable bit、重跑／firewall、release permission 與 self-loop 等問題。
- **backup/restore rehearsal 已完成且持續跑**：`scripts/backup-restore-rehearsal.mjs` 會建立 SQL marker 與檔案 sentinel → backup → 故意改資料 → restore → 驗證兩者恢復；`.github/workflows/verify.yml` 與 `.github/workflows/release.yml` 都有 `Rehearse backup and restore`。
- release path 已由 #12／#14 守住 package → install → migration → systemd → readiness、第二個 release 切換、重複 release-id 拒絕，以及 first-install／rollback self-loop 負向情境；對應 main merge 為 `46de6ae`、`2c3bd87`。

不再列為目前缺口：

- **OAuth**：目前 AppIdentity 使用 email/password + Redis session 已足以服務 `vps-mysql`。OAuth 是 Google StorageConnection／未來登入策略的需求，不是第一批 VPS 使用者的必要條件。
- **公開 TLS / Caddy**：目前院內正式架構是 WireGuard overlay，API 不對院內實體網卡公開，傳輸加密由 WireGuard 提供；`doc/almalinux-10-安裝.md` 已明確記錄此取捨。若未來改成 public ingress，才重新把 Caddy/TLS 列為必要上線條件。
- 「VPS 部署尚未達成」與「正式 restore 演練尚未完成」都是過期敘述，已刪除。

仍需要做、但屬營運而不是 Phase 2 功能實作的項目，是 off-site backup 真機驗收、真實目標主機的 reboot／網路邊界驗證、外部告警。詳見 Phase 7 與第 5 節。

### Phase 3：檔案生命週期 — `vps-mysql` 的 local-fs 垂直切片已完成

已完成：

- `packages/storage/local-fs/` private filesystem adapter。
- API upload/download/delete vertical slice。
- 大小、MIME、SHA-256、session expiry、tenant/owner 權限、retry。
- MySQL `pending`／`ready`／`deleted` metadata。
- 背景清理會處理過期 session、孤兒 `.part`、deleted content，並修復「檔案已完成但 session 尚未寫回」的中斷狀態。
- `packages/storage/local-fs/test/` 與 `apps/api/test/files*.test.ts` 提供 unit / integration coverage。
- 檔案與 MySQL 一起進 backup/restore rehearsal。

因此舊文「正式演練與部署仍未完成」已不成立。未來 R2／Drive 的檔案生命週期屬 Phase 5／6，不拿來降低這個 `vps-mysql` slice 的完成狀態。

### Phase 4：Desktop API adapter — `exam-server` 這個 repo 無法證明完成

本 repo 能證明 API contract、auth、retry 所需的 server 行為與檔案 API；但 desktop adapter 位於另一個 repo，不在本工單允許的作業範圍。

上線前仍需要取得外部驗收證據，至少要證明真桌面 App 經 WireGuard 對這台 server 能完成：

- login / refresh / 401 recovery。
- loading／timeout／retry。
- CRUD。
- upload progress／cancel／download。
- fake → real API adapter 切換不需要改業務 UI。

這裡刻意不寫「Phase 4 尚未完成」這種無法行動的句子。具體缺的是**跨 repo 的桌面端 E2E 驗收證據**，不是 `exam-server` 再加一段 server code。

### Phase 5：Cloudflare D1 + R2 — 尚未實作，缺口明確

目前 repo 沒有 `apps/api-worker/`、D1 adapter、R2 storage adapter 或 Wrangler local integration suite。

未來若要啟用此 profile，需完成：

- Worker API app 與 bindings。
- D1 schema／migration／repository。
- R2 upload/download（含 multipart 或 signed URL 策略）。
- Cloudflare session adapter。
- local-mode integration tests 與共用 contract suite。

這不是第一批 `vps-mysql` 院內使用者的上線阻塞。此處的「R2 adapter 尚未實作」是指 `cloudflare-d1-r2` application storage profile；Phase 7 的 R2 異地備份只是 `vps-mysql` 的營運備份目的地，不等於完成該 provider profile。

### Phase 6：Google Sheets + Drive — 尚未實作，缺口明確

目前 repo 沒有 Sheets repository、Drive storage adapter、StorageConnection/OAuth token store 或 reconciliation job。

未來若要啟用此 profile，需完成：

- StorageConnection / OAuth 與 refresh token 加密保存。
- Sheets stable ID／version／quota backoff。
- Drive resumable upload 與 metadata state machine。
- 跨 Sheets/Drive 中斷補償與 reconciliation。
- mock／sandbox contract tests。

這也不是第一批 `vps-mysql` 院內使用者的上線阻塞。

### Phase 7：營運與恢復 — 部分完成

把「功能已存在」與「真機殘餘風險」分開。

已完成：

- MySQL + private files 的 backup／restore tooling：`scripts/backup.mjs`、`scripts/restore.mjs`。
- destructive backup → mutate → restore → verify rehearsal，而且 PR/main Verify 與 Release Artifact 都會跑。
- **repo-side off-site backup tooling**：Cloudflare R2 upload/download、最近 30 份 retention、`--dry-run`、每日 systemd timer，以及會先刪本機演練 copy 再從 R2 restore 的 rehearsal path 已納入 repo；基本測試使用 fake R2 驗證 transport、retention 與 restore wiring。
- `vps-mysql` 的 package/install/rollback/systemd/readiness path 已由 release CI 實跑。
- structured log、request correlation、audit log、`/health/live`、`/health/ready` 已有實作與測試；`deploy/README.md` 說明 journald 操作。
- AlmaLinux 10 clean-host bootstrap 已實跑並留下多輪實機修正紀錄。

仍缺的具體營運能力：

- **off-site backup 真機驗收**：repo-side tooling 已存在，但還沒有證據顯示真實 AlmaLinux 主機用真 R2 credential 完成一次「排程備份送到不同故障域 → 從 off-site copy 還原並驗證」。在這次真機演練成功前，這一格仍未完成。
- **外部監測／告警**：現在有 health endpoint 與 log，但 repo 沒有會在服務故障時主動通知人的監測／告警配置。完整 metrics stack 可以後做，但第一批使用者至少需要 outage detection。
- **真實目標主機 reboot 驗收**：CI 會跑 systemd，bootstrap 會 enable 服務，但 GitHub-hosted Ubuntu gate 不等於一台正式 AlmaLinux 主機真的 reboot 後能自動恢復服務。
- **正式網路邊界驗收**：需要在目標主機上從授權 WireGuard peer 與未授權院內網路各測一次，確認 API 只在設計的 overlay 可達；CI 不能證明 firewalld／實體介面／上游網路設備的真實效果。
- **metrics**：原 Phase 7 明列 metrics，目前 repo 沒有 metrics 實作。它不是第一批使用者的硬阻塞，只要先有可靠的外部 health alert；之後再依營運需求補容量／延遲／錯誤率指標。
- **D1/R2/Google 的 backup／DR／reconciliation**：這些 provider 本身尚未實作，因此其 DR runbook 也還不存在；等 profile 真正開工時一起交付。

## 4. #12／#14 發布閘門已知未覆蓋的殘餘風險

這一節放在 `plan.md`，因為它描述的是「目前證據的邊界」，不是部署操作步驟。它們是**已知未覆蓋的殘餘風險，不等於每項都要立刻寫程式補掉**。

Release Artifact gate 雖然會真的 package、production-only install、migration、systemd、readiness、release switch／reject／rollback，但 runner 是 GitHub-hosted Ubuntu 24.04，因此仍不能替代以下真實環境驗證：

- **SELinux**：CI 不驗 AlmaLinux SELinux policy/label。現行正式架構已明確決定關閉 SELinux，所以這是接受「少一層 MAC」的安全取捨；若政策改回 enforcing，必須重新做真機驗證。
- **AlmaLinux 發行版差異**：dnf 套件、NodeSource RPM、MySQL/Valkey、systemd/firewalld 行為不由 Ubuntu CI 證明。
- **firewalld／真實 security group／實體網路邊界**：runner 無法證明院內 LAN、WireGuard overlay 或上游 ACL 的實際可達性。
- **reverse proxy／TLS／LB**：目前 WireGuard-only 架構不使用它們；若未來改成 public ingress，現有 gate 不涵蓋憑證、proxy header、LB health/routing 等部署風險。
- **跨機 MySQL/Redis(Valkey) 網路與 failover**：CI service container 是同 runner，不代表跨主機 DNS、TLS、ACL、延遲或 failover。
- **實機 Node RPM / Corepack 安裝**：release gate 會提供 Node/Corepack 給 systemd 使用，但不驗正式 AlmaLinux 上 RPM repository 與升級路徑。
- **reboot startup**：CI 能 start/stop systemd unit，不能模擬正式主機完整 reboot 後的依賴順序與自動恢復。
- **真實磁碟、mount、容量與 quota**：`/opt`、storage、backup 在 runner 上是暫存磁碟；不代表正式磁碟滿載、掛載失敗、inode/quota 或 I/O fault。
- **production 資料量**：測試資料規模不能代表正式 DB dump/restore、migration、檔案樹與 readiness 所需時間。
- **multi-host rollout / failover**：現行 profile 是單 VPS，gate 不驗多節點協調、traffic drain、active/passive 或跨節點 rollback。

## 5. 離「能服務真客戶」還差什麼？

以下只列目前院內 `vps-mysql` 單 VPS + WireGuard 目標中，**不做就容易真的出事**的項目。

### 正式 backup 必須完成一次真實異地還原驗收

repo 已有 R2 每日排程、最近 30 份 retention、dry-run 與從 off-site copy 還原的程式路徑；上線前仍必須在真實 AlmaLinux 主機用真 R2 credential 跑一次 `server-foundation-offsite-rehearse` 並成功。這一步未完成前，不把 off-site DR 標成已驗收。

不做的後果：VPS／磁碟與同機 backup 一起損毀時，即使 repo-side tooling 看起來完整，仍沒有真實環境證據證明異地 copy 可成功取回並恢復 MySQL 與檔案。

### 真正目標主機要做一次冷啟動與網路邊界驗收

至少包含 reboot 後服務自動回來、`/health/ready` 正常、授權 WireGuard peer 可達、未授權院內 LAN 不可達。

不做的後果：CI 全綠仍可能在主機重啟後停機，或因 HOST/firewalld/實體介面差異把 API 暴露到不該到的網路，或反過來讓合法桌面連不上。

### 必須有最小外部 health monitoring / alerting

不要求先上完整 metrics 平台，但要有獨立於 server process 的東西定期檢查可用性並通知維運者。

不做的後果：服務、MySQL、Valkey 或 storage 掛掉時，可能一直到使用者報案才知道。

### 必須取得真桌面 App 經 WireGuard 的 E2E 驗收證據

這不在 `exam-server` repo 內實作，但上線前必須證明 login/refresh、CRUD、timeout/retry、檔案 upload/download/cancel 走真 server 都成立。

不做的後果：只能證明 server 自己健康，不能證明真正使用者的產品路徑可用。

### 第一批使用者不必被這些項目卡住

- **OAuth**：email/password + session 已能提供 AppIdentity；除非產品決定把 Google/OAuth 納入第一批需求。
- **公開 Caddy/TLS**：目前 transport boundary 是 WireGuard，不提供 public HTTP ingress；改架構時才重新列入。
- **D1/R2、Sheets/Drive**：這些是其他 deployment profile，不是 `vps-mysql` 的必要依賴。
- **完整 metrics stack**：第一批先有可靠外部 health alert 即可；容量／延遲／SLO 指標可依實際營運補。
- **multi-host rollout**：目前是單 VPS 架構。它是可用性殘餘風險，不是單機首次上線的必要交付；若 RTO/RPO 要求提高，再改架構。

## 6. 證據索引

- 使用者建立流程存在且有測試：`scripts/create-user.mjs`、`scripts/create-user.test.mjs`、`package.json` 的 `test:create-user`。
- AlmaLinux 10 可從乾淨環境裝到服務與第一個帳號：`deploy/scripts/bootstrap-almalinux10.sh`、`doc/almalinux-10-安裝.md`、`c93042891cf363f29dd04cc1fd121043ef0799f0` 及其後續實跑修正。
- backup/restore rehearsal 真的 mutate 再 restore：`scripts/backup-restore-rehearsal.mjs`。
- rehearsal 每次在 CI 跑：`.github/workflows/verify.yml`、`.github/workflows/release.yml` 的 `Rehearse backup and restore`。
- off-site R2 repo tooling：`scripts/offsite-r2.mjs`、`scripts/offsite-backup.mjs`、`scripts/offsite-restore.mjs`、`scripts/offsite-backup-restore-rehearsal.mjs`、`deploy/scripts/install-offsite-backup.sh`、systemd timer 與 `doc/offsite-backup.md`；repo tests 使用 fake R2，真 AlmaLinux/R2 rehearsal 仍待完成。
- release path 真的走 package/install/migration/systemd/readiness：`.github/workflows/release.yml`，#12 merge `46de6ae`。
- first-install / rollback self-loop 也有負向 gate：`.github/workflows/release.yml`，#14 merge `2c3bd87`。
- structured log / request ID / audit / readiness 有測試：`apps/api/test/observability.test.ts`。
- local filesystem lifecycle 有實作與測試：`packages/storage/local-fs/`、`apps/api/test/files*.test.ts`。
- D1/R2 application profile 尚未實作：目前 repo tree 無 `apps/api-worker/`、D1/R2 application adapter。
- Google profile 尚未實作：目前 repo tree 無 Sheets/Drive adapter 或 StorageConnection/OAuth implementation。

## 7. 後續 provider 規劃

### `cloudflare-d1-r2`

- D1 使用自己的 SQLite schema／migration，不重用 MySQL-specific SQL。
- R2 使用 multipart 或短效 signed URL 處理大檔案。
- session 不依賴 Redis；做 Cloudflare 專用 adapter。
- 明確宣告 D1 容量、查詢與並行限制。
- local mode 必須能重現 integration/contract tests。

### `google-sheets-drive`

- 穩定 `id`，不得用 row number 當主鍵。
- 保留 `version`、`updatedAt`、`deletedAt`，並處理 quota/backoff。
- Sheets 與 Drive 無跨資源 transaction，必須有 compensation / reconciliation。
- Drive 採 resumable upload；metadata 先 `pending`，成功再 `ready`。
- refresh token 只在 server 端加密保存。
- 此 profile 不作大型、多租戶、高併發系統的預設資料庫。

## 8. 參考文件

- `README.md`
- `deploy/README.md`
- `doc/almalinux-10-安裝.md`
- `doc/offsite-backup.md`
- `.github/workflows/verify.yml`
- `.github/workflows/release.yml`
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Google Sheets API quotas](https://developers.google.com/workspace/sheets/api/limits)
- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
