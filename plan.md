# server-foundation 實作計畫

> 狀態：Phase 0～Phase 2 已完成；Phase 3 已完成檔案生命週期與背景清理的第一個可測試垂直切片，並加入 VPS 備份／還原工具。本文的未完成項目不代表已完成正式 restore rehearsal、OAuth 或部署。

## 1. 目標

`server-foundation` 要讓同一個 Windows 桌面 App，可以依部署需求使用不同的資料與檔案後端，而不需要修改 UI 或業務流程。

支援三種 deployment profile：

1. `vps-mysql`：VPS + MySQL + 私有檔案儲存
2. `cloudflare-d1-r2`：Cloudflare Workers + D1 + R2
3. `google-sheets-drive`：Google Sheets + Google Drive

共同原則：

- 桌面端只呼叫 HTTPS API，不直接連 MySQL、D1、Sheets 或 Drive。
- API contract、use case、權限與錯誤語意保持一致。
- provider 只實作 adapter，不把 provider 細節滲透到 route 或 UI。
- 不提供沒有業務權限的任意資料表 CRUD。
- 不把檔案內容放進 MySQL、D1 或 Sheets；資料庫只保存檔案 metadata。
- 不為了抽象而假裝三種後端擁有相同的交易、搜尋與併發能力。

## 2. 目標架構

```text
desktop-foundation
        │ HTTPS + api-contracts
        ▼
server-foundation
        ├── HTTP routes
        ├── authentication / authorization
        ├── use cases
        ├── audit / idempotency / error mapping
        └── provider ports
              ├── DataRepository
              ├── BlobStorage
              ├── SessionStore
              └── ExternalConnectionStore
                    │
        ┌───────────┼─────────────────────┐
        ▼           ▼                     ▼
   MySQL       D1 / R2              Sheets / Drive
   VPS         Workers              Google APIs
```

### 2.1 分層責任

```text
route
  → request validation
  → use case
  → authorization / tenant isolation
  → provider port
  → adapter
```

- `route` 不直接寫 SQL、操作檔案系統或呼叫 Google API。
- `use case` 定義產品行為，例如建立項目、上傳附件、刪除項目。
- `port` 定義可測試的能力邊界。
- `adapter` 處理 MySQL SQL、D1 SQL、Google API、VPS filesystem 或 R2 API。

## 3. 共用 port 與契約

### 3.1 資料 port

每個業務資源擁有自己的 repository 介面；不要做「輸入資料表名稱就能 CRUD」的通用 API。

```ts
interface ItemRepository {
  list(query: ItemListQuery): Promise<Page<Item>>;
  get(id: string): Promise<Item | null>;
  create(input: CreateItemInput): Promise<Item>;
  update(id: string, input: UpdateItemInput, version: number): Promise<Item>;
  softDelete(id: string, version: number): Promise<void>;
}
```

所有 provider 共用下列資料語意：

- `id` 使用應用程式產生的 UUID／ULID，不依賴 MySQL auto-increment。
- `createdAt`、`updatedAt` 使用 UTC ISO 8601 傳輸格式。
- 更新帶 `version`，避免最後寫入者無聲覆蓋前一個更新。
- 列表使用 opaque cursor；不得把 MySQL offset 行為直接暴露成跨 provider 契約。
- 刪除預設為 soft delete；硬刪除由明確的管理流程處理。
- 統一錯誤碼、request ID、冪等鍵與 audit 欄位。

### 3.2 檔案 port

```ts
interface BlobStorage {
  initiateUpload(input: UploadInput): Promise<UploadSession>;
  writeUpload(sessionId: string, body: ReadableStream): Promise<UploadProgress>;
  completeUpload(sessionId: string): Promise<FileMetadata>;
  getDownload(id: string): Promise<DownloadSource>;
  delete(id: string): Promise<void>;
}
```

共用 metadata 至少包含：

- 應用程式 `fileId`
- `ownerId`／`tenantId`
- 原始檔名與安全顯示名稱
- MIME type、大小、checksum
- provider reference，例如 filesystem key、R2 object key 或 Drive file ID
- `pending`、`ready`、`deleted` 狀態
- 建立者、建立時間、刪除時間

provider reference 只存在 server；桌面端只使用 `fileId`。

上傳流程固定為：

```text
POST   /api/files/upload-sessions
PUT    /api/files/upload-sessions/:id/parts 或 /content
POST   /api/files/upload-sessions/:id/complete
GET    /api/files/:id/download
DELETE /api/files/:id
```

API 可以在後端能力允許時回傳短效 upload/download URL，但 URL 格式不列入桌面端業務邏輯。

### 3.3 認證與外部連線分離

- `AppIdentity`：使用者登入 server 的身份、角色與租戶。
- `StorageConnection`：某個租戶或使用者授權 Google Drive 的連線。
- Google 帳號可以用來授權 Drive，但不代表它必須是應用程式的登入方式。
- MySQL、D1、Google service account、Redis 或其他 provider 憑證不得放進 EXE。

### 3.4 Provider capabilities

每個啟用的 provider 必須宣告能力，不支援的功能要明確失敗：

```ts
type ProviderCapabilities = {
  transactions: "full" | "request" | "none";
  optimisticConcurrency: boolean;
  cursorPagination: boolean;
  fullTextSearch: boolean;
  resumableUpload: boolean;
  serverSideFiltering: boolean;
};
```

產品若依賴某能力，啟動時或 use case 執行前要檢查 capability；不可把「未實作」當成成功。

## 4. 三種 provider profile

### 4.1 `vps-mysql`：第一優先、完整參考實作

```text
Node.js API
  ├── MySQL：業務資料、使用者、權限、metadata、audit
  ├── Redis：session、TTL、cache、rate limit
  └── private filesystem：檔案內容
```

規劃：

- MySQL 使用 provider 專屬 migration 與 integration tests。
- 檔案先放非公開 VPS 目錄；檔案 metadata 與內容分離。
- 檔案下載只能經過權限檢查，不暴露實體路徑。
- 以 transaction 保護需要一致性的多表更新。
- 以背景工作清理已刪除的檔案內容與過期 upload session。
- 備份 MySQL 與檔案儲存，並實際演練 restore。

這是 `server-foundation` 的預設部署模式，也是第一個要做到可用、可測試、可部署的 profile。

### 4.2 `cloudflare-d1-r2`：獨立 Workers adapter

```text
Cloudflare Worker
  ├── D1：SQLite 語意的結構化資料
  └── R2：檔案與其他 object
```

規劃：

- 新增獨立的 `apps/api-worker/`，不要把 Workers binding 塞進 Node API。
- 共用 `api-contracts`、domain types、use case 測試與錯誤語意。
- D1 使用自己的 SQLite schema／migration，不重用 MySQL-specific SQL。
- R2 優先使用 multipart 或短效 presigned URL 處理大檔案。
- session 另做 Cloudflare adapter；不把 Redis 假設成所有 deployment 的必要依賴。
- 對 D1 的容量、查詢時間、單一資料庫並行能力設定明確邊界。
- Worker、D1、R2 以 local mode 建立可重現測試。

D1 不應被包裝成「MySQL 的另一個連線字串」；它是不同 SQL 語意與執行模型的 provider。

### 4.3 `google-sheets-drive`：低併發、內部工具 profile

```text
Node.js API 或 Worker gateway
  ├── Google Sheets：小量結構化資料
  └── Google Drive：檔案與資料夾
```

規劃：

- Google API 只在 server adapter 呼叫，桌面端不持有 service account key。
- 每筆資料必須有穩定的 `id` 欄位；不得使用試算表 row number 當主鍵。
- 保留 `version`、`updatedAt` 與 `deletedAt` 系統欄位，避免人工編輯破壞同步判斷。
- 以 batch request 合併讀寫，配合 exponential backoff 與明確的 429／timeout 錯誤。
- Sheets 與 Drive 是兩個外部資源，不能宣稱跨資源 transaction；需要補償流程與 reconciliation job。
- 上傳先建立 `pending` metadata，Drive 完成後再轉為 `ready`；中斷項目由 reconciliation job 處理。
- 需要組織共用資料時優先評估 Shared Drive；權限繼承與 service account 配置要納入部署文件。
- OAuth refresh token 加密保存，只能由 server 使用；桌面 OAuth 只有在產品明確要「每位使用者連自己的 Drive」時才加入。

此 profile 適合小型內部工具、人工可見資料與低頻率操作，不作大型、多租戶、高併發系統的預設資料庫。

## 5. 能力差異矩陣

| 能力            | VPS + MySQL           | D1 + R2                  | Sheets + Drive                           |
| --------------- | --------------------- | ------------------------ | ---------------------------------------- |
| 關聯資料與 JOIN | 完整                  | SQLite 範圍              | 由 use case 組合，有限                   |
| 交易            | 多表 transaction      | 依 D1 語意與限制         | 單一 batch request，無跨資源 transaction |
| 併發更新        | transaction + version | version／provider 限制   | version、backoff、reconciliation         |
| 搜尋與排序      | SQL                   | SQLite SQL               | API／快取／受限查詢                      |
| 檔案上傳        | server stream         | R2 multipart／signed URL | Drive resumable upload                   |
| 大量資料        | 適合                  | 需受 D1 限制約束         | 不建議                                   |
| 主要用途        | 正式產品預設          | Serverless 部署          | 小型內部或低併發工具                     |

跨 provider 的共用 API 只承諾「最低共同能力」；進階功能必須透過 capability 或產品 profile 明確開啟。

## 6. 建議目錄

```text
apps/api/                         # Node.js HTTP API
apps/api-worker/                  # 後續的 Cloudflare Worker API
packages/api-contracts/           # request、response、error、file contracts
packages/domain/                  # use cases、業務規則、ports
packages/domain/ports/            # DataRepository、BlobStorage、session ports
packages/adapters/mysql/          # MySQL schema、migration、repositories
packages/adapters/d1/             # D1 schema、migration、repositories
packages/adapters/google-sheets/  # Sheets repository 與 quota/backoff
packages/storage/local-fs/        # VPS private filesystem
packages/storage/r2/               # Cloudflare R2
packages/storage/google-drive/     # Drive upload、download、permissions
packages/auth/                    # App identity、session、OAuth connection
packages/testing/                 # fake、contract suite、fixtures
```

`packages/api-contracts` 是桌面端與 server 的共用邊界，不另建一個獨立的 `shared-contracts` GitHub repository。

## 7. 實作階段

### Phase 0：決策與契約

- 定義第一個業務資源，不做抽象的任意 CRUD。
- 定義 error、pagination、version、idempotency 與 file metadata contract。
- 定義 `DataRepository`、`BlobStorage`、`SessionStore` 與 capabilities。
- 建立 fake adapters 與 provider contract test suite。
- 產出 ADR：provider 邊界、檔案生命週期、Google consistency、D1 migration。

驗收：桌面端可只依賴 contract 與 fake port 完成 loading、error、empty、success、retry 流程。

### Phase 1：Node API 核心

- 建立 TypeScript Node API、request validation、錯誤格式與 request ID。
- 加入第一個 resource 的 use case 與 route。
- 加入認證 middleware、租戶隔離與基本 audit event。
- 加入 API contract tests 與 negative tests。

驗收：不接真資料庫也能以 fake adapter 通過完整 API 測試。

### Phase 2：VPS + MySQL

- 建立 MySQL schema、migration、repository 與 integration tests。
- 加入 version check、soft delete、cursor pagination、transaction。
- 加入 Redis session、logout、refresh rotation 與 rate limit。

已完成：MySQL users/items migration、Argon2id password hashing、Bearer token、Redis session、atomic refresh rotation、logout revocation、tenant-scoped items、login rate limit，以及 MySQL＋private storage 的 backup／restore scripts 與 checksum smoke tests。使用者建立流程、OAuth、TLS／部署與正式 restore 演練仍未完成。

目前已達成：隔離環境中的 MySQL＋Redis API、CRUD、認證、租戶隔離與可驗證的備份／還原工具。尚未達成：off-site backup、正式 VPS restore rehearsal 與 VPS 部署。

### Phase 3：檔案生命週期

- 建立 private filesystem adapter。
- 實作 upload session、大小／MIME／checksum 驗證、取消、重試與清理。
- 實作下載權限、串流、range 或明確限制。
- 建立 partial upload、重複上傳與權限錯誤測試。

進度：`storage/local-fs` 與 API upload/download/delete vertical slice 已完成，包含 private root、大小／MIME／SHA-256、session expiry、tenant/owner 權限、retry、MySQL pending／ready／deleted metadata，以及 API 程序內的背景清理 job。清理會處理過期 session、孤兒 `.part`、殘留 deleted content，並以 checksum 修復「檔案已完成但 session 尚未寫回」的中斷狀態。備份／restore 工具已加入；正式演練與部署仍未完成。

驗收：檔案內容永不直接公開，metadata 與實體檔案狀態可被重建與檢查。

### Phase 4：Desktop API adapter

- 在 `desktop-foundation` 實作 API port 與 fake／real adapter 切換。
- 使用 `api-contracts` 生成或共用型別。
- 驗證斷線、逾時、重試、401、refresh、上傳進度與取消。

驗收：UI 不知道後端 provider，切換 fake 與 VPS API 不需修改業務元件。

### Phase 5：Cloudflare D1 + R2

- 建立 Worker API app 與 bindings。
- 實作 D1／R2 adapters 與 provider-specific migrations。
- 使用 Wrangler local mode 做 integration tests。
- 實作 R2 multipart、signed URL 與權限包裝。

驗收：相同 API contract test suite 在 D1/R2 通過；不支援的能力會明確回傳錯誤。

### Phase 6：Google Sheets + Drive

- 建立 OAuth／StorageConnection 流程與 token 加密保存。
- 實作 Sheets repository、stable ID、version、quota backoff。
- 實作 Drive resumable upload、metadata state machine 與 reconciliation job。
- 建立 mock／sandbox contract tests，不使用 production spreadsheet 或 Drive 資料。

驗收：小量資料可完成 CRUD、上傳、下載、權限錯誤與中斷恢復；超過能力邊界時會拒絕或明確降級。

### Phase 7：營運與恢復

- MySQL、檔案、D1、R2、Google provider 分別建立備份／恢復策略。
- 建立 structured log、audit log、metrics、health check 與 request correlation。
- 建立 provider migration、data export、reconciliation 與 disaster recovery runbook。
- 執行乾淨環境部署與 restore 演練。

## 8. 設定方式

以 profile 選擇預設組合，但內部仍拆成獨立 provider 設定，保留日後混用的空間：

```text
APP_PROFILE=vps-mysql

APP_PROFILE=cloudflare-d1-r2

APP_PROFILE=google-sheets-drive
```

啟動時必須驗證：

- profile 所需的設定是否完整。
- provider 組合是否合法。
- capabilities 是否滿足啟用的 use case。
- secret 是否來自部署環境，而非 repo 或桌面 bundle。

## 9. 不在第一輪做的事

- 不同時完成三套真實 provider。
- 不做任意資料表 CRUD。
- 不把 MySQL SQL 自動轉成 D1 SQL。
- 不讓桌面端直接保存資料庫或 Google service account 憑證。
- 不把 Google Sheets 當成高併發關聯式資料庫。
- 不先做 migration、deploy 或 production data import。
- 不為了支援最小共同能力而犧牲 MySQL profile 的正確交易與權限模型。

## 10. 參考文件

- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare R2 S3 API](https://developers.cloudflare.com/r2/get-started/s3/)
- [R2 upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Google Sheets API quotas](https://developers.google.com/workspace/sheets/api/limits)
- [Google Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
