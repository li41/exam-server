# Cloudflare R2 異地備份

本機 `scripts/backup.mjs` 的行為不變；這一層把它產生的完整 backup 封裝成
`tar.gz` 後送到 Cloudflare R2，並保留最近 30 份日備份。

## 為什麼選 R2、為什麼排程

- 既有系統已使用 Cloudflare，不新增供應商；R2 提供 S3 相容 API。
- 備份 token 只授權一個專用 bucket 的 Object Read & Write。它能讀回自己的備份、
  刪除超過 retention 的舊備份，但不能改 WireGuard/control plane。
- 備份漏一天本身就是風險，因此不像 WireGuard peer sync 採手動；使用 systemd timer
  每天 03:30 執行，另加最多 30 分鐘隨機延遲，`Persistent=true` 讓關機錯過的排程
  在下次開機補跑。
- retention 固定保留最近 30 份成功上傳的日備份。這個單 VPS 規模先採單純的 30 個
  restore points，不做 daily/weekly/monthly 分層，讓刪除規則容易人工核對。

## 安裝

先完成主 bootstrap，再在 repo 根目錄執行：

```bash
bash deploy/scripts/install-offsite-backup.sh
```

第一次會建立：

```text
/etc/server-foundation/offsite-backup.env   0600 root:root
```

檔案仍有 `CHANGE_ME` 時，installer 只安裝 timer，不會啟用它。建立一個專用 R2
bucket 與只限該 bucket 的 Object Read & Write API token，然後：

```bash
sudoedit /etc/server-foundation/offsite-backup.env
```

填入 Cloudflare 提供的 Account ID、Access Key ID、Secret Access Key 與 bucket 名稱。
這個檔案由 Node 當 `KEY=VALUE` 資料解析，不會 `source` 成 shell；secret 也不會放在
命令列參數。

## 啟用前先 dry-run

```bash
sudo /usr/local/sbin/server-foundation-offsite-backup --dry-run
```

輸出有兩區：

- `會保留`：依 LastModified 排序後最新的 30 份。
- `會刪除`：第 31 份之後的舊備份；正式執行會不可逆刪除這些 R2 objects。

`--dry-run` 不建立本機 backup、不上傳，也不刪除。若遠端清單列取失敗，程式直接
失敗，沒有任何刪除動作。

確認後啟用每天排程：

```bash
sudo systemctl enable --now server-foundation-offsite-backup.timer
sudo systemctl list-timers server-foundation-offsite-backup.timer
```

要立即跑一次：

```bash
sudo /usr/local/sbin/server-foundation-offsite-backup
```

## 從異地還原

列出的最新 backup 可直接下載、驗 SHA-256、解開，再走既有 `restore.mjs` 驗 manifest
與檔案 checksum：

```bash
sudo RESTORE_CONFIRM=YES \
  /usr/local/sbin/server-foundation-offsite-restore --latest
```

也可以指定 dry-run 看到的完整 object key：

```bash
sudo RESTORE_CONFIRM=YES \
  /usr/local/sbin/server-foundation-offsite-restore \
  --key server-foundation/backups/backup-...tar.gz
```

## 真機異地還原演練

下面這條是破壞性演練。它會建立 SQL/file sentinel、做本機 backup、上傳 R2，接著
**刪除剛產生的本機 backup**，故意改資料，再從 R2 下載並 restore，最後驗 SQL 與
檔案 sentinel 都回來：

```bash
sudo OFFSITE_REHEARSAL_CONFIRM=YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE \
  /usr/local/sbin/server-foundation-offsite-rehearse
```

這條必須在真的 AlmaLinux 主機、真的 R2 bucket/token 上至少成功一次，才能把
「從異地 copy 已實際恢復」標成完成。repo/CI 的 fake R2 測試只證明程式路徑，不能
取代這項正式環境驗收。
