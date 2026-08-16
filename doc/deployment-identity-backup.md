# Deployment identity、桌面版租戶比對與備份還原防呆

`WO-DEPLOYMENT-IDENTITY`（#33）先把「這台機器服務哪家公司、哪個專案」變成備份資料的一部分；`WO-TENANT-UUID-ADOPT`（#39）再把公司識別從可枚舉的整數 `company_id` 改成 exam-control 的 `companies.tenant_uuid`（UUIDv4），並讓桌面版只能讀到比對所需的 tenant UUID。

## 身分放哪

身分仍放在既有 `/etc/server-foundation/server-foundation.env`：

```dotenv
DEPLOYMENT_TENANT_UUID=f47ac10b-58cc-4372-a567-0e02b2c3d479
DEPLOYMENT_PROJECT_ID=item-bank-main
```

- `DEPLOYMENT_TENANT_UUID`：必須等於 exam-control `companies.tenant_uuid`，格式為 UUIDv4。程式會正規化成小寫。
- `DEPLOYMENT_PROJECT_ID`：保留。它是同 tenant 不同專案的穩定識別字串；不是秘密，最多 128 個可列印字元。

不用 DB 一列，因為這是**機器/部署常數**，不是業務資料維度；也不拆現有業務表的 `tenant_id`。local backup、off-site backup、restore、installer 與 API process 都讀同一份部署設定，避免另外維護第二份身分來源。

`DEPLOYMENT_PROJECT_ID` 沒改成 UUID：它只需要穩定區分「同一 tenant 的兩台／兩個專案」，目前沒有跨系統既有 UUID 可以對齊；強行造 UUID 只會增加人工對照成本，沒有額外隔離效果。

## 桌面版比對端點

正式服務在兩個既有 API prefix 都提供同一個唯讀端點：

```text
GET /api/v1/deployment/tenant
GET /api/deployment/tenant   # legacy prefix compatibility
```

回應只有：

```json
{
  "tenantUuid": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

這個端點**不要求認證**。理由是桌面版要在決定是否相信這台機器的題庫資料之前，就能把「CF 目前切到的 tenant」與「眼前這台服務的 tenant」做比對；tenant UUID 是隨機識別，不是 credential。要求先登入這台反而會把比對放到太晚。

端點刻意不回 `DEPLOYMENT_PROJECT_ID`、版本、檔案路徑、主機資訊或其他設定。桌面版目前只需要 tenant UUID 來發現「試務在乙、題庫主機在甲」這種錯配。

正式環境若沒有合法 `DEPLOYMENT_TENANT_UUID`，API 啟動設定驗證會 fail closed，不會啟動一台無法供桌面版比對的服務。development/test 可不填，方便既有單元測試與 in-memory 開發。

## manifest 欄位

新備份維持 manifest v1，但 deployment identity 改成：

```json
{
  "version": 1,
  "deployment": {
    "tenantUuid": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "projectId": "item-bank-main"
  }
}
```

manifest version 仍不升版：資料庫/storage payload 沒改，只有 restore safety attribute 的識別格式改變。目前正式環境沒有既有備份需要遷移。

#33 時期的 `{ companyId, projectId }` deployment 形狀現在視為**格式不合法**，不會被誤當成新 tenant UUID 身分，也不能用 identity override 略過 malformed manifest。完全沒有 `deployment` 的 legacy backup 則仍走 #33 原本的 `backup=unknown` fail-closed 規則。

## restore 規則

一般還原仍要先有原本的：

```bash
RESTORE_CONFIRM=YES
```

接著 restore 比對 manifest 的 `deployment` 與目前機器 env：

- tenant UUID + project 都相同：正常繼續 checksum、MySQL、storage 還原。
- 任一不同：**在執行 MySQL 前就拒絕**。
- 舊備份沒有 `deployment`：視為 `backup=unknown`，**預設拒絕**。
- manifest 有 `deployment` 但格式壞掉（包含舊 `companyId` 形狀）：直接視為 manifest invalid，不允許靠 override 略過。

錯誤訊息會同時列出 backup 與 current，例如：

```text
Backup deployment identity mismatch: backup=tenant_uuid="8a1bc8c4-0f55-4b50-8d98-e8bc9f0415b4", project_id="old-project"; current=tenant_uuid="f47ac10b-58cc-4372-a567-0e02b2c3d479", project_id="item-bank-main". Refusing restore.
```

## 刻意跨部署還原

真正要跨機搬資料時仍可做，但不能只加一個 boolean flag。除了 `RESTORE_CONFIRM=YES`，操作者還必須完整輸入：

```bash
RESTORE_DEPLOYMENT_OVERRIDE_CONFIRM=YES_I_UNDERSTAND_THIS_BACKUP_IS_FOR_A_DIFFERENT_DEPLOYMENT
```

這個確認字串同時適用於：

- 已知 identity mismatch；
- legacy v1、沒有 deployment identity 的備份。

它**只略過 deployment identity gate**，不會略過 manifest 格式、checksum、storage checksum 或原本 destructive restore confirmation。

## off-site backup / restore

`server-foundation-offsite-backup` 仍先從 app env 讀 deployment identity，再建立本機 backup；因此上傳到 R2 的 archive 內 manifest 一定帶 tenant UUID + project identity。`--dry-run` 也會先驗 identity，避免 installer 啟用一個之後只能產生不安全備份的 timer。

`server-foundation-offsite-restore` 仍從同一個 app env 讀目前機器 identity，再交給共用 `restoreBackup()`；沒有另一套判斷。

目前沒有改 R2 object key namespace；`--latest` 若選到別台機器的最新 object，restore 會清楚指出 mismatch 並停止。安全保證仍是「拿錯不能默默成功」，不是重新設計 bucket layout。

## installer / migration

`deploy/env/server-foundation.env.example` 現在使用 `DEPLOYMENT_TENANT_UUID=CHANGE_ME`，不再保留名稱叫 company id、實際卻放 UUID 的混亂狀態。

`install-offsite-backup.sh` 會在安裝/啟用 timer 前檢查：

- `DEPLOYMENT_TENANT_UUID` 是 UUIDv4；
- `DEPLOYMENT_PROJECT_ID` 已填且不是 `CHANGE_ME`。

因此舊機器如果仍只有 `DEPLOYMENT_COMPANY_ID`，installer 會 fail closed，直到部署者依 exam-control 的 `tenant_uuid` 更新 env。部署與正式環境設定由維運者執行，本 repo 不自動改現場 env。

## 測試證據

backup regression tests 保留並更新 #33 的四個安全性質：

1. mismatch 錯誤同時列出 backup/current tenant UUID + project；
2. cross-deployment restore 仍要完整長確認字串；
3. 沒有 deployment 的 legacy backup 預設拒絕；
4. matching identity 的正常 fake-MySQL + storage round trip 仍成功。

另外增加舊 `{ companyId, projectId }` manifest 即使有 override 也不能通過的測試，以及 API 測試證明未認證 client 只拿得到 `{ tenantUuid }`，沒有 project 或其他 deployment 設定。

## 不在這張做的事

- 不拆、不改業務表 `tenant_id`。
- 不做多租戶。
- 不改題庫、WireGuard、開機、告警。
- 不改 R2 object key / backup 路徑。
- 不把 deployment identity 當秘密，也不把任何 credential 寫進 manifest 或 endpoint。
- 不自動接受舊備份。
