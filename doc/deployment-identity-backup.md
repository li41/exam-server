# Deployment identity 與備份還原防呆

`WO-DEPLOYMENT-IDENTITY`（#33）把「這台機器服務哪家公司、哪個專案」變成備份資料的一部分，避免共用 R2 bucket 時把別台機器的備份無聲還原進來。

## 身分放哪

身分放在既有 `/etc/server-foundation/server-foundation.env`：

```dotenv
DEPLOYMENT_COMPANY_ID=123
DEPLOYMENT_PROJECT_ID=item-bank-main
```

- `DEPLOYMENT_COMPANY_ID`：必須是正整數，值等於 exam-control 的 `company_id`。
- `DEPLOYMENT_PROJECT_ID`：同公司不同專案的穩定識別字串；不是秘密，最多 128 個可列印字元。

不用 DB 一列，因為這是**機器/部署常數**，不是業務資料維度；也不拆現有 `tenant_id`。把它放進既有 app env 的好處是 local backup、off-site backup、restore 與 installer 都已經有同一個安全檔案可以讀，不需要再造另一份容易漂移的設定。

## manifest 欄位

新備份在既有 manifest v1 加上一個 additive 欄位：

```json
{
  "version": 1,
  "deployment": {
    "companyId": 123,
    "projectId": "item-bank-main"
  }
}
```

manifest version 沒有因這個欄位升版：檔案/資料庫 payload 格式沒有改，只多了一個 restore safety attribute。這也讓既有 v1 備份可以被辨識成「legacy、沒有 deployment」，走明確的 fail-closed 規則，而不是先被 generic version error 擋掉。

## restore 規則

一般還原仍要先有原本的：

```bash
RESTORE_CONFIRM=YES
```

接著 restore 比對 manifest 的 `deployment` 與目前機器 env：

- company + project 都相同：正常繼續 checksum、MySQL、storage 還原。
- 任一不同：**在執行 MySQL 前就拒絕**。
- 舊備份沒有 `deployment`：視為 `backup=unknown`，**預設拒絕**。
- manifest 有 `deployment` 但格式壞掉：直接視為 manifest invalid，不允許靠 override 略過。

錯誤訊息會同時列出 backup 與 current，例如：

```text
Backup deployment identity mismatch: backup=company_id=7, project_id="old-project"; current=company_id=42, project_id="item-bank-main". Refusing restore.
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

`server-foundation-offsite-backup` 會先從 app env 讀 deployment identity，再建立本機 backup；因此上傳到 R2 的 archive 內 manifest 一定帶 identity。`--dry-run` 也會先驗 identity，避免 installer 啟用一個之後只能產生不安全備份的 timer。

`server-foundation-offsite-restore` 會從同一個 app env 讀目前機器 identity，再交給共用 `restoreBackup()`；沒有另一套判斷。

目前沒有改 R2 object key namespace；`--latest` 若選到別台機器的最新 object，restore 會清楚指出 mismatch 並停止。這張單的安全保證是「拿錯不能默默成功」，不是重新設計 bucket layout。

## installer / migration

`deploy/env/server-foundation.env.example` 新增兩個 `CHANGE_ME` 欄位。既有 bootstrap 本來就會列出 env 中所有 `CHANGE_ME`，所以舊安裝升級後需要由操作者把兩個值補進 `/etc/server-foundation/server-foundation.env`。

`install-offsite-backup.sh` 會在安裝/啟用 timer 前檢查：

- `DEPLOYMENT_COMPANY_ID` 是正整數；
- `DEPLOYMENT_PROJECT_ID` 已填且不是 `CHANGE_ME`。

因此舊機器不會在未補 identity 的狀態下重新啟用 off-site backup timer。

## rehearsal 證據

兩支 destructive rehearsal 都增加同一格：

1. 建立帶正確 identity 的 backup。
2. 人工產生另一個有效但不相同的 deployment identity。
3. 呼叫**真的 `restoreBackup()`**，確認在任何 MySQL restore 前得到 identity mismatch。
4. 接著照原流程破壞資料，再用正確 identity 做完整 restore。
5. 最後仍驗資料庫 marker 與 storage sentinel 都回來。

本機版回傳 `identityMismatchRejected: true`；異地版是在已從 R2 下載/解包後做同一個拒絕證明，再跑真正 off-site restore。

## 不在這張做的事

- 不拆、不改業務表 `tenant_id`。
- 不做多租戶。
- 不改題庫、WireGuard、開機或告警。
- 不把 deployment identity 當秘密，也不把任何 credential 寫進 manifest。
- 不自動接受舊備份。
