# server-foundation

可重複使用的 TypeScript production API 基底，主要服務 Windows Desktop App 與其他受控 client。部署目標是一般 Linux VPS：Caddy 對外提供 HTTPS，Node API 綁 loopback，MySQL 保存永久資料與 durable idempotency ledger，Redis 保存 session／限流狀態，private filesystem 保存檔案內容。

## 現在具備什麼

目前 P1～P5.1 的基礎能力已接在同一套架構內：

- **P1 Correctness**：共用 API error contract、MySQL migration lock 與 dirty migration 防護。
- **P2 Runtime hardening**：graceful shutdown、account + IP login rate limit、upload-session concurrency lock。
- **P3 Operability**：集中 config validation、liveness/readiness、request ID、structured JSON logs、GitHub Actions `pnpm verify`。
- **P4 Production operations**：systemd/Caddy/env 範本、audit log、MySQL/Redis/API integration CI、真實 backup → mutate → restore rehearsal。
- **P5 API & release safety**：`/api/v1`、legacy alias、`Idempotency-Key`、contract compatibility gate、dependency audit/Dependabot、tag release artifact、原子部署與 rollback。
- **P5.1 Correctness hardening**：MySQL durable idempotency ledger、ambiguous mutation fail-closed、N-1 application migration rollback compatibility gate。

```text
Desktop App
    │ HTTPS
    ▼
Caddy
    │ 127.0.0.1:8787
    ▼
Node.js / Hono API
    ├── MySQL：items、users、file metadata、audit events、idempotency records
    ├── Redis：sessions、rate limits
    └── private storage：file content / upload state
```

正式環境要求 `MYSQL_URL`、`REDIS_URL`、`FILE_STORAGE_ROOT` 全部存在，否則 server 會直接拒絕啟動。

## API versioning

正式 client 應使用：

```text
/api/v1/auth/...
/api/v1/items/...
/api/v1/files/...
```

原本的 `/api/...` 目前仍是 **v1 legacy alias**，避免既有 Desktop Client 被立即切斷。兩套路徑共用同一組 handlers；API response 會帶：

```text
X-API-Version: v1
```

legacy alias 另外會帶：

```text
X-API-Legacy-Route: true
```

新 client 不應再新增對 legacy prefix 的依賴。共用 package 也匯出 `API_VERSION`、`API_VERSION_PREFIX`、`LEGACY_API_PREFIX`。

## Idempotency-Key

受保護的 `POST`、`PATCH`、`DELETE` item/file mutation 支援 `Idempotency-Key`。Streaming upload content 的 `PUT` 不使用這個機制；auth login/refresh/logout 也不納入，以免把 token lifecycle 混入一般業務冪等語意。

範例：

```http
POST /api/v1/items
Authorization: Bearer <access-token>
Content-Type: application/json
Idempotency-Key: 018f8ad7-create-item-42

{"title":"Quarterly report"}
```

Production 以 MySQL `idempotency_records` 作為 authoritative durable ledger。第一次 request 先建立 `pending` reservation；成功後保存 request fingerprint 與成功 response。相同 tenant、method、canonical path、key、body/query 的重送會直接 replay 已完成 response，並回傳：

```text
X-Idempotent-Replay: true
```

同一 key 若改用不同 body/query 會得到 `409 conflict`；同 key 的第一個 request 尚未完成時，平行 request 也得到 `409`。成功完成的結果預設保存 86400 秒，可用 `IDEMPOTENCY_TTL_SECONDS` 設為 60～604800 秒。

P5.1 對 crash ambiguity 採 **fail-closed**：`pending` record 不會因短 TTL 自動過期後重新取得 reservation。若 process 在副作用可能已發生、但成功 response 尚未 durable 保存時中斷，同一 key 後續仍會被視為 pending，而不是再次執行 mutation。這是保守的 at-most-once 防重策略；它不宣稱 MySQL 與 filesystem 之間存在跨儲存體 exactly-once transaction。若 client 明確送出 `Idempotency-Key` 但 server 沒有 durable idempotency store，server 不會靜默忽略，而是回 `capability_missing`。

## API contract 相容性

共用 Zod schemas 位於：

```text
packages/api-contracts/
```

v1 公開 surface manifest 位於：

```text
contracts/api-v1.json
```

代表舊版 client 行為的 parsing fixtures 位於：

```text
contracts/api-v1-fixtures.json
```

`pnpm verify` 會用目前 schemas 解析所有既有 fixture；Pull Request CI 另外執行 `contract:compatibility`，將 PR 的 v1 manifest 與 base branch 比較，阻擋 endpoint 移除、authentication/idempotency 語意改變、closed enum 改變、既有欄位移除/改型，以及新增 required request field。需要真正 breaking change 時，應新增下一個 API version，而不是直接破壞 v1。

## API routes

### Auth

```text
POST /api/v1/auth/login
POST /api/v1/auth/refresh
GET  /api/v1/auth/me
POST /api/v1/auth/logout
```

### Items

```text
GET    /api/v1/items
GET    /api/v1/items/:id
POST   /api/v1/items
PATCH  /api/v1/items/:id
DELETE /api/v1/items/:id?version=<n>
```

### Files

```text
POST   /api/v1/files/upload-sessions
PUT    /api/v1/files/upload-sessions/:id/content
POST   /api/v1/files/upload-sessions/:id/complete
DELETE /api/v1/files/upload-sessions/:id
GET    /api/v1/files/:id/download
DELETE /api/v1/files/:id
```

檔案內容不經 MySQL blob 儲存；MySQL 保存 metadata，private filesystem 保存內容。下載前由 API 驗證 tenant/owner/admin scope，再串流回傳。

## Health、logging 與 audit

```text
GET /health/live
GET /health/ready
GET /health        # backward-compatible liveness alias
```

每個 request 都會產生或驗證 UUID request ID，並回 `X-Request-Id`。Structured logs 包含 request ID、method、path、status、duration 與已驗證 identity metadata，不記 Authorization、password 或 request body。

Authenticated mutation 會寫入 MySQL `audit_events`。Audit persistence 採 durable best-effort：寫入失敗會產生 structured warning，但不把已完成的業務 mutation 改成 500。

## 本機啟動

安裝與驗證：

```bash
corepack enable
corepack prepare pnpm@11.22.0 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

開發模式可以不設定 backing services，items 會使用 in-memory repository 與 local development identity：

```bash
corepack pnpm --filter @server-foundation/api dev
```

使用真實 MySQL/Redis/storage：

```bash
MYSQL_URL='mysql://<user>:<password>@127.0.0.1:3306/<database>' \
REDIS_URL='redis://127.0.0.1:6379' \
FILE_STORAGE_ROOT='/var/lib/server-foundation/storage' \
IDEMPOTENCY_TTL_SECONDS='86400' \
  corepack pnpm --filter @server-foundation/api dev
```

Migration 必須明確執行；API 啟動不會自行修改 schema：

```bash
MYSQL_URL='mysql://<user>:<password>@127.0.0.1:3306/<database>' \
  corepack pnpm --filter @server-foundation/mysql-adapter migrate
```

## CI / security gates

`.github/workflows/verify.yml` 在 PR 與 `main` push 執行：

1. TypeScript build + test typechecking
2. oxlint
3. Prettier check
4. unit tests
5. build
6. v1 fixture compatibility
7. PR 對 base branch 的 v1 breaking-change 檢查
8. production dependency audit（high 以上）
9. MySQL + Redis + API integration tests
10. PR migration 後，以 base branch（N-1）application 對新 schema 重跑 integration tests
11. 真實 backup/restore rehearsal

N-1 gate 的目的不是做 schema downgrade，而是證明 **新 migration 套用後，上一版 application 仍可工作**，讓 deployment readiness 失敗時的 code rollback 有可驗證的相容性前提。

`.github/dependabot.yml` 每週檢查 npm/pnpm dependencies 與 GitHub Actions 更新。Actions 使用固定 commit SHA，避免只依賴可移動 tag。

## Release 與 rollback

推送 `v*` Git tag 或手動執行 `Release Artifact` workflow，會再次跑 verify、production dependency audit、MySQL/Redis/API integration、N-1 application migration compatibility 與 backup/restore rehearsal；全部成功才產生：

```text
server-foundation-<version>.tar.gz
server-foundation-<version>.tar.gz.sha256
server-foundation-<version>.manifest.json
```

VPS 使用 immutable releases + `current` symlink：

```text
/opt/server-foundation/releases/v1.2.3
/opt/server-foundation/current -> /opt/server-foundation/releases/v1.2.3
```

安裝：

```bash
sudo deploy/scripts/install-release.sh ./server-foundation-v1.2.3.tar.gz v1.2.3
```

installer 會驗證 SHA-256（若同目錄有 checksum）、解壓、安裝 production dependencies、執行 migration、原子切換 `current`、restart systemd，再輪詢 `/health/ready`。新版本 readiness 失敗時會自動把 symlink 切回上一版。

手動 rollback：

```bash
sudo deploy/scripts/rollback-release.sh v1.2.2
```

Migration 採 forward-only；每次 schema change 都由 CI/release gate 實際驗證「前一版 application」能在新 schema 上通過 integration tests。部署細節見 [`deploy/README.md`](./deploy/README.md)。

## Backup / restore

正式 backup 包含 MySQL dump，以及 private storage 的 `files/`、`metadata/`。因此 durable idempotency ledger 也包含在 MySQL backup 中；Redis 的 session/rate-limit 狀態具 TTL，不屬於永久 backup。

```bash
MYSQL_URL='mysql://...' \
FILE_STORAGE_ROOT='/var/lib/server-foundation/storage' \
BACKUP_ROOT='/var/backups/server-foundation' \
  corepack pnpm backup
```

Restore 會覆寫目標 database，必須明確確認並先停止 API：

```bash
BACKUP_DIR='/var/backups/server-foundation/backup-...' \
MYSQL_URL='mysql://...' \
FILE_STORAGE_ROOT='/var/lib/server-foundation/storage' \
RESTORE_CONFIRM='YES' \
  corepack pnpm restore
```

CI 與部署變更後應持續執行 `pnpm backup:rehearse`，但只能對隔離測試 DB/storage 使用。

## Production environment

範本：[`deploy/env/server-foundation.env.example`](./deploy/env/server-foundation.env.example)

核心設定：

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
MYSQL_URL=mysql://...
REDIS_URL=redis://...
FILE_STORAGE_ROOT=/var/lib/server-foundation/storage
TRUST_PROXY_HEADERS=true
FILE_CLEANUP_INTERVAL_SECONDS=300
IDEMPOTENCY_TTL_SECONDS=86400
SHUTDOWN_TIMEOUT_SECONDS=30
```

Secrets 只由部署環境注入；不要提交 populated `.env`、token、private key 或 database credential。

## Repository layout

```text
apps/api/                         Node/Hono HTTP API
packages/api-contracts/           client/server Zod contracts
packages/domain/                  use cases + ports
packages/auth/                    password/token/session service
packages/adapters/mysql/          MySQL repositories + migrations + audit + durable idempotency
packages/adapters/redis/          sessions + rate limit + legacy Redis idempotency adapter
packages/storage/local-fs/        private filesystem storage
packages/testing/                 in-memory test adapters
contracts/                        API compatibility manifests/fixtures
deploy/                           Caddy/systemd/env/release/rollback
scripts/                          backup/restore/contract/release/rollback-compat tooling
.github/workflows/                verify + release CI
```

## 設計原則

- API route 不直接散落 SQL 或 filesystem 操作。
- MySQL、Redis、storage 透過 ports/adapters 隔離。
- tenant scope 在 repository/use-case 邊界持續存在。
- Client/server 共用 contract，但不共用 database model。
- Production 失敗要可觀測、可停止、可恢復、可回滾。
- v1 一旦對 client 發佈，就以 compatibility gate 保護；breaking change 走新 API version。
- 對可能被 client 重送的 mutation，優先使用 `Idempotency-Key`，不要靠 client 假設 timeout 等於「server 沒有執行」。
- 無法證明 mutation 沒有副作用時，idempotency 採 fail-closed，不因短 TTL 自動重新執行。
- Forward-only migration 必須維持 N-1 application compatibility，否則 code-only rollback 不具可信度。

完整歷史規劃仍可參考 [`plan.md`](./plan.md)，但實際現況以本 README、CI 與 production deploy 文件為準。
