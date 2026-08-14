# AlmaLinux 10 全新機器 → 可以跑 `deploy/README.md` 的狀態

## 這份文件的邊界（先看這段）

`deploy/README.md` 已經寫了**服務帳號、目錄配置、release 安裝與回滾**，那份是權威。

⚠️ **這份不重寫它**，只補它假設你已經有、但全新機器沒有的東西：作業系統套件、資料庫、Caddy、防火牆、SELinux。

⇒ **做完這份的第 1-8 步，就直接接 `deploy/README.md` 的「Create the service account and directories once」往下做。**

---

## 這套東西長什麼樣（決定後面每一步為什麼那樣做）

```
外面 ──HTTPS(443)──► Caddy ──HTTP──► 127.0.0.1:8787 (Node API)
                                          │
                                          ├─► MySQL   127.0.0.1:3306
                                          ├─► Redis   127.0.0.1:6379
                                          └─► 檔案     /var/lib/server-foundation/storage
```

⚠️ **只有反向代理對外**（Caddy 或 OpenResty 皆可，見步驟 6）。 API、MySQL、Redis **全部綁 loopback**，這是設計不是省事——
所以防火牆**只開 80/443**，**8787／3306／6379 一個都不要開**。

### 為什麼是公開 HTTPS，而不是 VPN／封閉內網（2026-08-14 決策，別再重來一次）

曾評估過「不開 80/443、改用 WireGuard 只給特定內網連」。**結論是不採用**，原因不在技術可行性，在維運成本：

- **桌面版是客戶自己安裝、機器分散、我方碰不到。** 裸 WireGuard **沒有自動註冊機制**——
  每多一台就要產一組金鑰、在伺服器加一個 `[Peer]`、把私鑰送到那台。**維運量隨台數線性成長，且永遠不會停。**
- 要自動化就得再架 Headscale／NetBird 這類控制面（客戶端一行 `--authkey` 自助註冊）。
  **那是為「你管得到的機器」設計的**，客戶自裝的機器仍然要有人去跑那行指令。
- **VPN 在這裡多擋掉的，是「未登入者連不到 API 表面」**；而應用層本來就有認證與限流（見下）。
  ⇒ 多出來的那層防護，**價值低於它每接一個客戶就要付一次的成本**。

**⇒ 所以防線放在應用層，不放在網路層。** 這代表下面這幾件事不是可選項：

| 防線 | 在哪 | 證據 |
|---|---|---|
| 登入限流（依來源 IP、跨帳號累計） | API | `apps/api/test/runtime-hardening.test.ts:73` |
| 預設不信任 `X-Forwarded-*`，要明示開啟 | API | `apps/api/test/runtime-hardening.test.ts:105` |
| MySQL／Redis／API 只綁 loopback | 本文步驟 4-6 | 防火牆只開 80/443 |
| TLS | 反向代理 | 步驟 6 |

⚠️ **`TRUST_PROXY_HEADERS` 必須開**（不論用 Caddy 還是 OpenResty）。反向代理在前面，
API 直接看到的來源永遠是 `127.0.0.1`——**沒開的話登入限流會把全世界算成同一個人**，等於沒有限流。
⚠️ 反過來說，**開了就代表你信任那個標頭**，所以 API 只能綁 loopback、絕不能讓外面繞過代理直打 8787（否則來源 IP 可偽造）。

## 版本（皆取自 repo 實際設定，非推測）

| 元件 | 版本 | 出處 |
|---|---|---|
| Node | **24** | `.github/workflows/*.yml` 的 `node-version` |
| MySQL | **8.4** | CI service image（Percona Server 8.4 亦可，見步驟 4） |
| Redis | **7.4** | CI service image |
| pnpm | **11.10.0** | `package.json` 的 `packageManager` |

⚠️ **Node 必須裝在 `/usr/bin/node`** —— systemd unit 的 `ExecStart` 是寫死的絕對路徑
（`deploy/systemd/server-foundation.service`）。用 nvm 裝在家目錄**會啟動失敗**。

---

## 動手前要準備的

1. **一個網域**，A record 已指向這台機器的 IP（Caddy 要用它自動申請憑證，沒指好會一直失敗）
2. **一個 email**（ACME 通知用）
3. root 或可 sudo 的帳號

---

## 步驟 1：系統基礎

```bash
sudo dnf -y update
sudo dnf -y install curl tar policycoreutils-python-utils
sudo timedatectl set-timezone Asia/Taipei
```

⚠️ `policycoreutils-python-utils` 是為了之後排查 SELinux 用的（`semanage`／`audit2why`），現在裝好省得出事才找。

## 步驟 2：Node 24

**先看 AppStream 有沒有：**

```bash
dnf module list nodejs
```

- **有 `nodejs:24`** → `sudo dnf -y module install nodejs:24`
- **沒有** → 用 NodeSource：
  ```bash
  curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
  sudo dnf -y install nodejs
  ```

**驗證（這一步不能跳）：**

```bash
node -v            # 要是 v24.x
command -v node    # ⚠️ 必須是 /usr/bin/node
```

⚠️ 第二行不是 `/usr/bin/node` 就先解決它，否則後面 systemd 一定起不來。

## 步驟 3：pnpm（只有要在機器上建置才需要）

正常流程是 **CI 打包好 release、機器上只解壓**（見 `deploy/README.md` 的 Release artifacts），
**那條路不需要 pnpm**。只有你要在這台機器上自己 build 才裝：

```bash
sudo corepack enable
corepack prepare pnpm@11.10.0 --activate
```

## 步驟 4：MySQL 8.4

```bash
sudo dnf -y install mysql-server
sudo systemctl enable --now mysqld
sudo mysql_secure_installation
```

### 用 Percona Server 取代原廠 MySQL（可以，我查證過）

**程式這一側完全不需要改**：驅動是 `mysql2`（`packages/adapters/mysql/package.json`），
用到的 MySQL 專屬功能只有 `GET_LOCK`／`RELEASE_LOCK`（`packages/adapters/mysql/src/migrate.ts:72` 的
migration lock）與 `CHECK` 約束——**都是 MySQL 8 內建，Percona Server 全部支援**（它本來就是 MySQL 加上額外功能）。

```bash
sudo dnf -y install https://repo.percona.com/yum/percona-release-latest.noarch.rpm
sudo percona-release setup ps84       # ⚠️ 要對到 8.4，別裝成 8.0
sudo dnf -y install percona-server-server
sudo systemctl enable --now mysqld
```

⚠️ **三件跟原廠不同的**：

1. **初始 root 密碼在 log 裡**，不是空的：
   `sudo grep 'temporary password' /var/log/mysqld.log`
2. **服務名仍是 `mysqld`**、設定仍在 `/etc/my.cnf.d/` ⇒ 下面的 loopback 設定與建帳號步驟**照樣適用**。
3. ⚠️ **AlmaLinux 10 的 Percona 套件我沒查證**（同 OpenResty 那條，新版 RHEL 系的支援有時間差）。
   `percona-release setup ps84` 若找不到 el10 的套件，就退回原廠 `mysql-server`。

**綁 loopback**（`/etc/my.cnf.d/` 下任一 `.cnf`，例如 `mysql-server.cnf`）：

```ini
[mysqld]
bind-address = 127.0.0.1
```

```bash
sudo systemctl restart mysqld
```

**建資料庫與使用者**（帳密要與待會的 `MYSQL_URL` 一致）：

```sql
CREATE DATABASE server_foundation CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'server_foundation'@'127.0.0.1' IDENTIFIED BY '換成你的密碼';
GRANT ALL PRIVILEGES ON server_foundation.* TO 'server_foundation'@'127.0.0.1';
FLUSH PRIVILEGES;
```

⚠️ 用 `'127.0.0.1'` 不要用 `'localhost'`——MySQL 把它們當**兩個不同的帳號**，
而連線字串走的是 `127.0.0.1`。這一格寫錯會得到「密碼明明對卻拒絕存取」。

## 步驟 5：Redis 7.4

```bash
sudo dnf -y install redis
```

`/etc/redis/redis.conf` 確認：

```
bind 127.0.0.1 -::1
protected-mode yes
```

```bash
sudo systemctl enable --now redis
redis-cli ping        # 要回 PONG
```

## 步驟 6：Caddy

```bash
sudo dnf -y install 'dnf-command(copr)'
sudo dnf -y copr enable @caddy/caddy
sudo dnf -y install caddy
```

把 `deploy/caddy/Caddyfile.example` 放到 `/etc/caddy/Caddyfile`，並填掉兩個變數：

- `{$SERVER_DOMAIN}` → 你的網域
- `{$ACME_EMAIL}` → 你的 email

（範本裡的 `reverse_proxy 127.0.0.1:8787` 不要改，那是 API 的固定位址。）

```bash
sudo systemctl enable --now caddy
```

### 替代方案：用 OpenResty 取代 Caddy

兩條路都可以，**但差別不只是換一個軟體**：

| | Caddy | OpenResty |
|---|---|---|
| HTTPS 憑證 | **自動申請、自動續期** | ⚠️ **要自己接**（certbot 或 lua-resty-acme） |
| 設定檔 | repo 裡有範本（`deploy/caddy/Caddyfile.example`） | ⚠️ **repo 裡沒有** |
| 適合什麼時候選 | 這台機器只跑這個服務 | 你本來就在用 OpenResty、要統一維運方式 |

⚠️⚠️ **若你選 OpenResty，請把設定檔放進 `deploy/openresty/` 進版控，不要只留在這份文件裡。**
理由：**只活在文件裡的設定一定會腐爛**——程式改了沒人會回來改它，而下一個照文件做的人會踩到。
repo 裡的 Caddy 範本之所以可靠，正是因為它跟程式在同一個版控裡。

最小可用的 OpenResty 設定（`/usr/local/openresty/nginx/conf/conf.d/server-foundation.conf`）：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name  <你的網域>;

    ssl_certificate     /etc/letsencrypt/live/<你的網域>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<你的網域>/privkey.pem;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    server_tokens off;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
}
server {
    listen 80;
    server_name <你的網域>;
    return 301 https://$host$request_uri;
}
```

⚠️ **三件跟 Caddy 不同、會咬人的**：

1. **憑證要自己來**：`sudo dnf -y install certbot` → `sudo certbot certonly --standalone -d <你的網域>`
   （申請時 80 埠要先空著），**並且要自己確認續期排程有在跑**（`systemctl list-timers | grep certbot`）。
2. **`TRUST_PROXY_HEADERS`**：上面設定有送 `X-Forwarded-*`，那個環境變數要跟著設對，
   否則 API 取到的來源 IP 會是 `127.0.0.1`——**登入限流會因此把所有人算成同一個人**。
3. ⚠️ **OpenResty 在 AlmaLinux 10 的套件我沒查證**（官方 repo 對新版 RHEL 系的支援時間差）。
   裝之前先確認有沒有 el10 的套件，沒有的話要自己編或退回 Caddy。

## 步驟 7：防火牆——**只開 80／443**

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

⚠️ **不要開 8787／3306／6379。** 那三個對外開放等於把 API、資料庫、快取直接暴露在公網——
它們綁 loopback 就是為了不需要防火牆規則來保護。

## 步驟 8：SELinux

AlmaLinux 預設 **enforcing**，⚠️ **不要用 `setenforce 0` 關掉它**——那是把問題藏起來。

**最可能卡住的一格是 Caddy 反向代理到 loopback。** 先確認狀態：

```bash
getenforce
```

**部署完之後**若 Caddy 回 502 而 API 自己 `curl` 得通，先看是不是 SELinux 擋的：

```bash
sudo ausearch -m AVC -ts recent
sudo ausearch -m AVC -ts recent | audit2why
```

⚠️ **我沒有 AlmaLinux 10 的機器可以實測**，所以不給你一條「照打就好」的指令——
`audit2why` 會直接告訴你要開哪個 boolean，**照它說的做比照我猜的做可靠**。

（若確定是反向代理的網路連線被擋，常見解法是
`sudo setsebool -P httpd_can_network_connect 1`，⚠️ **但請以 `audit2why` 的輸出為準**。）

## 步驟 9：交棒

到這裡作業系統這一層就緒了。**接著照 `deploy/README.md` 做：**

1. `Create the service account and directories once` 那一段（建 `server-foundation` 帳號與五個目錄）
2. 填 `/etc/server-foundation/server-foundation.env`
3. 安裝 release：`sudo deploy/scripts/install-release.sh <artifact> <version>`

### 環境變數要填的十一個

`NODE_ENV`、`HOST`、`PORT`、`MYSQL_URL`、`REDIS_URL`、`FILE_STORAGE_ROOT`、
`TRUST_PROXY_HEADERS`、`FILE_CLEANUP_INTERVAL_SECONDS`、`IDEMPOTENCY_TTL_SECONDS`、
`SHUTDOWN_TIMEOUT_SECONDS`、`BACKUP_ROOT`

⚠️ `HOST=127.0.0.1`、`PORT=8787` **不要改**——Caddy 的設定與這兩個綁在一起。
⚠️ `TRUST_PROXY_HEADERS` **要開**——理由與它的前提條件見上面〈為什麼是公開 HTTPS〉那節，不是隨手設的。

---

## 完成後的檢查清單

```bash
systemctl status caddy server-foundation --no-pager   # 兩個都要 active
curl -s http://127.0.0.1:8787/health                  # 機器內部
curl -s https://<你的網域>/health                      # 從外面
sudo ss -ltnp | grep -E '8787|3306|6379'              # ⚠️ 三個都要是 127.0.0.1
```

⚠️ **最後那一行最重要**：若看到 `0.0.0.0:3306` 或 `0.0.0.0:6379`，表示某個服務綁到全部介面了，
**那是要立刻修的**，不要因為「反正防火牆有擋」就放著。

---

## ⚠️ 三個容易踩的坑

**① `/usr/bin/node` 是寫死的。** systemd unit 的 `ExecStart` 用絕對路徑。
用 nvm、或裝到 `/usr/local/bin`，服務會起不來而且錯誤訊息只說找不到檔案。

**② 備份寫不進去「不是 bug」，不要去放寬 systemd 設定。**
unit 是 `ProtectSystem=strict` 且 `ReadWritePaths` 只列了 `/var/lib/server-foundation`，
看起來備份目錄 `/var/backups/server-foundation` 寫不進去——
但**備份是 `scripts/backup.mjs` 獨立執行的、不是 API 服務在寫**（我查過整個 repo，服務端沒有讀 `BACKUP_ROOT`）。
⇒ **把備份目錄加進 `ReadWritePaths` 只會削弱防護，不會修好任何東西。**

**③ MySQL 的 `localhost` 與 `127.0.0.1` 是兩個帳號。** 見步驟 4。

---

## 這份文件裡哪些是查證過的、哪些不是

**✅ 從 repo 實際檔案讀出來的**：所有版本號、`/usr/bin/node`、`127.0.0.1:8787`、
十一個環境變數、目錄配置、備份由獨立腳本執行。

**⚠️ 未在 AlmaLinux 10 上實測**：`dnf module list nodejs` 有沒有 24、Caddy 的 COPR 套件名、
以及 SELinux 實際會擋哪一條。**這三處我給的是「怎麼自己確認」而不是「照打就好」。**
你裝完若與這份不符，**以機器上看到的為準**，並回報我來更新這份文件。
