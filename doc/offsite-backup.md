# Cloudflare R2 異地備份：院內主機只具上傳能力

這一層沿用既有 `scripts/backup.mjs` 產生的完整 backup，封裝成 `tar.gz`
後送到 Cloudflare R2。#31 之後，**正常運作中的院內主機不再保存 R2 Object
Read & Write credential，也不再直接 list/delete R2 objects**。

## R2 官方權限實際支援什麼

Cloudflare R2 的**長效** bucket-scoped object token 預設只有：

- **Object Read & Write**：可讀、可寫、可列出 objects；
- **Object Read only**：可讀取與列出 objects。

因此不能把 #22 原本的 Object Read & Write token 留在主機，再把它叫成
write-only。

R2 在 2026 年加入 **Temporary Credentials** 後，另有更細的 action scope：可信環境
可以自行簽發短效 S3 credential，只允許例如 `PutObject`、
`CreateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload`，而不授權
`DeleteObject`。但目前 `actions` 精細 scope **只支援 local signing**；也就是 parent R2
secret 必須待在可信 backend／Worker，不能把 parent secret 放到院內主機。

本實作沒有把 JWT minting 與 temporary S3 credential 再暴露給院內主機，而採更窄的
Worker upload façade：R2 binding 留在 Cloudflare，院內主機只持有一枚只能呼叫
create/upload-part/complete/probe 的 Worker secret。這同樣達成「院內 credential 無
delete capability」，而且 host 連 R2 list/read API 都碰不到。

官方文件：

- R2 API tokens：<https://developers.cloudflare.com/r2/api/tokens/>
- R2 Temporary Credentials：<https://developers.cloudflare.com/r2/api/s3/temporary-credentials/>
- R2 Workers API：<https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>
- R2 multipart upload：<https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/>
- R2 Object Lifecycles：<https://developers.cloudflare.com/r2/buckets/object-lifecycles/>
- R2 Bucket Locks：<https://developers.cloudflare.com/r2/buckets/bucket-locks/>

## 新的權限切分

```text
院內主機（steady state）
  /etc/server-foundation/offsite-backup.env
  ├─ OFFSITE_UPLOAD_URL   ───────┐
  └─ OFFSITE_UPLOAD_TOKEN        │ outbound HTTPS only
                                 v
Cloudflare Worker ─────────────> R2 bucket
  ├─ HTTP API 只提供 multipart upload / probe
  ├─ 沒有 GET / DELETE endpoint
  └─ HTTP surface 沒有 list / GET / DELETE

災難還原時才暫時加入：
  /run/server-foundation/offsite-restore.env
  └─ R2 Object Read only credential ──> list / GET only
```

### 為什麼 upload 經 Worker

R2 的長效 token 沒有 write-without-delete 預設，因此 Worker 是權限縮減邊界：
院內主機持有的 secret 只能呼叫這支 Worker 暴露的 upload surface。Worker 本身透過
R2 binding 寫 bucket，但 HTTP API 沒有 read/delete/retention action。

備份可能超過 Workers 單一 request body limit，因此不是把整個 `tar.gz` 一次 POST；
`offsite-backup.mjs` 使用 R2 multipart upload，預設每 part 8 MiB。Worker 只代轉
create/upload-part/complete。Object key 使用既有 backup 名稱（含 UUID），Worker
也先 `head()` 並拒絕覆寫已存在的 key。

### retention 改由誰執行

**改由 R2 Object Lifecycle 執行，不由院內主機，也不由 upload Worker 執行。**

原本院內主機的 `applyRetention()` 會 list 後 DELETE 舊 objects，這要求主機持有
R2 delete capability，與 #31 的安全目標衝突，所以 host-side retention 已移除。

一開始可以想到「把最新 30 份的刪除搬進 Worker Cron」，但這仍有一個間接刪除
通道：如果院內主機遭入侵，攻擊者雖然不能 DELETE，卻可以快速上傳大量新 key，
把真正的 backup 擠出「最新 30 份」，再讓 Cron 替它刪掉舊 restore points。

因此 #31 **刻意把 retention 從 count-based 改成 age-based**：

- R2 Object Lifecycle：`server-foundation/backups/` **35 天後 expire**；
- 建議再加 Bucket Lock：同 prefix **至少保留 30 天**。

這樣 compromised uploader 最多能製造額外 objects／費用，不能靠大量上傳加速既有
backup 的刪除。每一份成功 backup 都至少依自己的 age 活到 policy 時間，而不是受後來
新增了幾份 object 影響。

35 天不是宣稱「等價於最新 30 份」；它是安全取捨後的新 retention contract。正常每日
一份時大約會有 35 個 restore points，比原本 30 份略寬；若某幾天沒有成功備份，也不會
因為要湊 count 而提早刪除既有 copy。

Cloudflare 官方說 Object Lifecycle 可按 prefix 與 age 自動 expire objects；Bucket Lock
會阻止指定期間內的 delete/overwrite，而且 lock 優先於 lifecycle。這兩個 bucket policy
都由 Cloudflare account/bucket 管理，不需要把 bucket-management credential 放在院內主機。

建議由有 Cloudflare 管理權限的維運端執行：

```bash
npx wrangler r2 bucket lifecycle add <BUCKET> \
  expire-offsite-backups-35d server-foundation/backups/ \
  --expire-days 35

npx wrangler r2 bucket lock add <BUCKET> \
  protect-offsite-backups-30d server-foundation/backups/ \
  --retention-days 30
```

然後用 `r2 bucket lifecycle list` 與 bucket lock list/dashboard 再人工核對實際 policy。
Bucket Lock 是 defense in depth；即使未採用，主機 credential 本身仍沒有 delete path，
但採用 lock 可以再降低 Cloudflare 側程式錯誤或管理誤操作立即破壞近期 restore points
的風險。

## Cloudflare 端要建立的東西

以下是 owner 要在 Cloudflare 建立的外部資源；repo-side 程式不需要等待它們才能完成：

1. 使用既有專用 R2 backup bucket，或建立新的專用 bucket。
2. 部署 `deploy/cloudflare/offsite-backup-worker.mjs`。
3. 依 `deploy/cloudflare/offsite-backup-worker.wrangler.jsonc.example` 綁定：
   - `BACKUP_BUCKET` → 專用 R2 bucket；
   - `BACKUP_PREFIX=server-foundation/backups`。
4. 用 `wrangler secret put UPLOAD_TOKEN` 建一個高熵 upload secret；**不要把 secret
   寫進 wrangler config 或 repo**。
5. 在 R2 bucket 上建立 prefix-scoped lifecycle：35 天後 expire；建議再加 30 天
   Bucket Lock。這些 policy 只在 Cloudflare 管理端設定。
6. 另建立一枚限該 backup bucket 的 **Object Read only** R2 API token，放離線
   密碼庫／維運 secret store，**不要常駐院內主機**。
7. #22 舊的 Object Read & Write token 完成 migration 後立即 revoke。

## 從舊 #22 設定遷移

舊 `/etc/server-foundation/offsite-backup.env` 內含：

```text
R2_ACCOUNT_ID=...
R2_BUCKET=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

新的 installer 若看到這些 legacy keys，會：

1. 先 `disable --now server-foundation-offsite-backup.timer`；
2. **拒絕覆蓋既有 credential**；
3. 明確要求先部署 Worker、revoke 舊 write token，再手動改 env。

這是刻意 fail-closed，避免重跑 installer 時把真正 secret 蓋掉，或在 migration 半途
繼續讓 delete-capable credential 自動執行。

完成 Cloudflare 端設定後，把 `/etc/server-foundation/offsite-backup.env` 手動改成：

```text
OFFSITE_UPLOAD_URL=https://<your-worker>/
OFFSITE_UPLOAD_TOKEN=<upload-secret>
OFFSITE_UPLOAD_PART_SIZE_MIB=8
R2_PREFIX=server-foundation/backups
```

然後重跑：

```bash
bash deploy/scripts/install-offsite-backup.sh
```

installer 會維持此檔 `0600 root:root`，重跑不覆蓋既有 upload secret。

## 啟用前 dry-run

```bash
sudo /usr/local/sbin/server-foundation-offsite-backup --dry-run
```

#31 之後 `--dry-run` 的語意改成**安全 probe**：只驗 Worker URL 與 upload auth，
不建立本機 backup、不上傳，也不會 list/read/delete R2。院內主機已沒有能力列出
「會刪哪些 R2 objects」，因為 retention 已移到 R2 bucket policy。

probe 成功後，installer 才會 enable 每日 timer。手動立即備份：

```bash
sudo /usr/local/sbin/server-foundation-offsite-backup
```

成功輸出會包含 object key、archive SHA-256 與 multipart part count；不會輸出 upload
secret。

## 從異地還原：使用獨立 Object Read only credential

還原 path 仍然是：

```text
R2 list/GET → x-amz-meta-sha256 驗證 → tar 解開 → 既有 restore.mjs
```

差別是它不再讀 steady-state upload env，而是預設讀：

```text
/run/server-foundation/offsite-restore.env
```

從離線 secret store 取出 **Object Read only** credential，暫時建立：

```bash
sudo install -d -m 0700 -o root -g root /run/server-foundation
sudo install -m 0600 -o root -g root \
  /path/from/secure-media/offsite-restore.env \
  /run/server-foundation/offsite-restore.env
```

格式可從安裝後的
`/usr/local/share/server-foundation/offsite-restore.env.example` 複製：

```text
R2_ACCOUNT_ID=...
R2_BUCKET=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_PREFIX=server-foundation/backups
```

然後：

```bash
sudo RESTORE_CONFIRM=YES \
  /usr/local/sbin/server-foundation-offsite-restore --latest
```

或指定完整 key：

```bash
sudo RESTORE_CONFIRM=YES \
  /usr/local/sbin/server-foundation-offsite-restore \
  --key server-foundation/backups/backup-...tar.gz
```

完成後立即移除：

```bash
sudo rm -f /run/server-foundation/offsite-restore.env
```

read-only client 的程式 surface 只有 `listObjects()` 與 `getObjectToFile()`，沒有
`putObject()` 或 `deleteObject()`。下載後仍驗 `x-amz-meta-sha256`，checksum 不符就
拒絕 restore 並刪掉暫存檔。

## 真機異地還原演練

演練需要同時證明 upload-only path 與 read-only recovery path 能接起來，所以執行前
也要暫時放入 `/run/server-foundation/offsite-restore.env`：

```bash
sudo OFFSITE_REHEARSAL_CONFIRM=YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE \
  /usr/local/sbin/server-foundation-offsite-rehearse
sudo rm -f /run/server-foundation/offsite-restore.env
```

演練會：

1. 建 SQL/file sentinel；
2. 建本機 backup；
3. 透過 upload-only Worker 上傳；
4. **刪掉剛建立的本機 backup**；
5. mutate DB/file；
6. 使用 Object Read only R2 credential 把同一份 archive 下載回來；
7. 驗 SHA-256、解開、走既有 restore；
8. 驗 SQL/file sentinel 都恢復。

演練結束**不再從院內主機 DELETE 遠端 rehearsal object**；它和其他正式 backup
一樣由 R2 Lifecycle 到期處理。這避免為了測試偷偷把 delete capability 加回來。

## installer 與 WireGuard env 是否互踩

查過，沒問題：

- off-site installer 只建立／chmod／chown
  `/etc/server-foundation/offsite-backup.env`；
- WireGuard bootstrap 只操作
  `/etc/server-foundation/wireguard-peer-sync.env`；
- 兩邊都使用精確 file path，沒有對 `/etc/server-foundation/` 做 recursive
  chmod/chown，也不會覆蓋對方內容。

#31 沒有修改 WireGuard installer/path。

## repo 測試能證明與不能證明的範圍

`test:offsite-backup` 會證明：

- steady-state upload env 拒絕 legacy R2 S3 credentials；
- Worker HTTP surface 沒有 GET/DELETE，且拒絕覆寫既有 backup key；
- upload client 走 multipart，upload secret 只在 Authorization header；
- upload Worker 沒有 scheduled/delete path；retention 不受 uploader 的 object count 控制；
- restore R2 client 只有 list/get；
- remote archive 仍必須下載、解包後才能進既有 restore；
- installer 把 steady-state upload secret 與 recovery-only read credential 分離。

它**不能**取代以下正式環境驗收：

- 真 Worker / R2 binding 是否已部署；
- 舊 Object Read & Write token 是否真的已 revoke；
- 真 Object Read only token 的 bucket scope 是否正確；
- 真 AlmaLinux 上一份正式 backup 經 Worker 上傳，再用臨時 read-only credential
  成功完成一次異地 restore rehearsal；
- 35 天 Lifecycle 與 30 天 Bucket Lock（若採用）的真實 bucket policy 是否已生效。

這些在真 Cloudflare / 真主機完成前都只能標成「沒跑到」，不能寫成已驗收。
