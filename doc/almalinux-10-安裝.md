# AlmaLinux 10 全新機器 → 可以跑 `deploy/README.md` 的狀態

**架構：封閉內網，只從 WireGuard 隧道進來，不對外開 80／443。**

## 這份文件的邊界（先看這段）

`deploy/README.md` 是**服務帳號、目錄配置、release 安裝與回滾**的權威，這份不重寫它。
這份只補它假設你已經有、但全新機器沒有的：作業系統套件、資料庫、**網路**、SELinux。

⇒ **做完第 1-8 步，接 `deploy/README.md` 的「Create the service account and directories once」往下做。**

## ⚠️⚠️ 與 repo 現有資產的分歧（一定要知道）

`deploy/` 裡有 `caddy/Caddyfile.example`，`deploy/README.md` 也是照「Caddy 對外提供 HTTPS」寫的。

**本架構不使用反向代理**，所以：

- ❌ `deploy/caddy/Caddyfile.example` **這個架構下用不到**
- ❌ `deploy/README.md` 提到的公開 HTTPS 那部分**不適用**
- ✅ 它的**服務帳號、目錄配置、install/rollback 腳本****完全適用**

⚠️ **這是刻意的分歧，不是遺漏。** 若之後決定改回公開架構，以 `deploy/README.md` 為準。

---

## 架構長什麼樣

```
客戶場地 ──WireGuard(UDP 51820)──► VPS
                                    │
                                    ▼
                          10.x.x.x:8787  Node API（綁 WG 介面）
                                    ├─► MySQL  127.0.0.1:3306
                                    └─► Redis  127.0.0.1:6379
```

⚠️ **沒有反向代理。** 隧道本身已經同時做了加密與身分驗證——**只有持正確金鑰的端點連得進來**。
在隧道內再疊一層 TLS 是可選的加強，不是必要層。

⚠️ **對外只有一個 UDP 埠。** TCP 全關：8787／3306／6379 一個都不開。

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

## 步驟 1：系統基礎

```bash
sudo dnf -y update
sudo dnf -y install curl tar policycoreutils-python-utils
sudo timedatectl set-timezone Asia/Taipei
```

`policycoreutils-python-utils` 是之後排查 SELinux 用的（`semanage`／`audit2why`），先裝好。

## 步驟 2：Node 24

```bash
dnf module list nodejs
```

- **有 `nodejs:24`** → `sudo dnf -y module install nodejs:24`
- **沒有** → `curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -` 然後 `sudo dnf -y install nodejs`

**驗證（不能跳）：**

```bash
node -v            # v24.x
command -v node    # ⚠️ 必須是 /usr/bin/node
```

## 步驟 3：pnpm（只有要在機器上建置才需要）

正常流程是 CI 打包好 release、機器上只解壓（見 `deploy/README.md`），**那條路不需要 pnpm**。

```bash
sudo corepack enable && corepack prepare pnpm@11.10.0 --activate
```

## 步驟 4：資料庫（原廠 MySQL 或 Percona 二擇一）

**原廠：**
```bash
sudo dnf -y install mysql-server && sudo systemctl enable --now mysqld && sudo mysql_secure_installation
```

**Percona Server**（程式這側完全不用改——驅動是 `mysql2`，只用到 `GET_LOCK`／`RELEASE_LOCK` 與 `CHECK`，兩者都支援）：
```bash
sudo dnf -y install https://repo.percona.com/yum/percona-release-latest.noarch.rpm
sudo percona-release setup ps84      # ⚠️ 對到 8.4，別裝成 8.0
sudo dnf -y install percona-server-server && sudo systemctl enable --now mysqld
sudo grep 'temporary password' /var/log/mysqld.log   # ⚠️ 初始密碼在 log 裡、不是空的
```

**兩者共同：綁 loopback**（`/etc/my.cnf.d/` 下任一 `.cnf`）：

```ini
[mysqld]
bind-address = 127.0.0.1
```

```sql
CREATE DATABASE server_foundation CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'server_foundation'@'127.0.0.1' IDENTIFIED BY '換成你的密碼';
GRANT ALL PRIVILEGES ON server_foundation.* TO 'server_foundation'@'127.0.0.1';
FLUSH PRIVILEGES;
```

⚠️ 用 `'127.0.0.1'` 不要用 `'localhost'`——MySQL 把它們當**兩個不同帳號**，而連線字串走 `127.0.0.1`。
寫錯會得到「密碼明明對卻拒絕存取」。

## 步驟 5：Redis 7.4

```bash
sudo dnf -y install redis
```

`/etc/redis/redis.conf`：`bind 127.0.0.1 -::1`、`protected-mode yes`

```bash
sudo systemctl enable --now redis && redis-cli ping     # PONG
```

## 步驟 6：WireGuard（伺服器端）

```bash
sudo dnf -y install wireguard-tools
umask 077
wg genkey | sudo tee /etc/wireguard/server.key | wg pubkey | sudo tee /etc/wireguard/server.pub
```

`/etc/wireguard/wg0.conf`：

```ini
[Interface]
Address    = 10.99.0.1/24
ListenPort = 51820
PrivateKey = <server.key 的內容>

# ── 客戶場地從這裡往下加，一個場地一段 ──
```

```bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show                      # 看得到 interface 就對了
ip -brief addr show wg0           # 應該看到 10.99.0.1/24
```

⚠️ **不需要開 IP 轉發**。客戶端只連這台機器上的 API，不是把這台當跳板出去。
`net.ipv4.ip_forward` **維持關閉**——開了等於讓客戶場地能透過你的機器互連。

## 步驟 7：防火牆——**只開 UDP 51820**

```bash
sudo firewall-cmd --permanent --add-port=51820/udp
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

⚠️ **不要開 80／443／8787／3306／6379。**
對外掃描只會看到一個 UDP 埠，而且 WireGuard **不回應未經認證的封包**——比開 443 安靜得多。

## 步驟 8：SELinux

AlmaLinux 預設 **enforcing**，⚠️ **不要用 `setenforce 0` 關掉**——那是把問題藏起來。

出事時先看它到底擋了什麼：

```bash
sudo ausearch -m AVC -ts recent | audit2why
```

⚠️ **我沒有 AlmaLinux 10 可以實測**，所以不給「照打就好」的指令——`audit2why` 會直接告訴你要開哪個 boolean，
**照它說的做比照我猜的做可靠**。

## 步驟 9：交棒 `deploy/README.md`

照它做：建 `server-foundation` 帳號與五個目錄 → 填 env → `install-release.sh`。

### ⚠️ 環境變數有兩處要與範本不同

範本是照「有反向代理」寫的，**本架構要改這兩個**：

| 變數 | 範本值 | **本架構** | 為什麼 |
|---|---|---|---|
| `HOST` | `127.0.0.1` | **`10.99.0.1`**（WG 介面位址） | 沒有代理了，API 要直接聽 WG 介面 |
| `TRUST_PROXY_HEADERS` | （依範本） | **關閉** | ⚠️ **沒有代理卻信任 `X-Forwarded-For`，客戶端可以自己偽造來源 IP，登入限流形同虛設** |

⚠️⚠️ **`HOST` 絕對不要填 `0.0.0.0`**——那會連公網介面一起綁上去，等於把 API 直接暴露在網際網路。
**填 WG 介面那個位址，不是「全部」。**

其餘九個照範本填：`NODE_ENV`、`PORT`、`MYSQL_URL`、`REDIS_URL`、`FILE_STORAGE_ROOT`、
`FILE_CLEANUP_INTERVAL_SECONDS`、`IDEMPOTENCY_TTL_SECONDS`、`SHUTDOWN_TIMEOUT_SECONDS`、`BACKUP_ROOT`。

---

## 新增一個客戶場地

⚠️ **一個場地一組金鑰，不是一台電腦一組。** 一個客戶 20 台電腦只需要 1 組——
維運量從 N 降到 1。代價是那個場地的內網都連得到 API，**而那一層本來就該由登入與權限擋，不該靠網路層當唯一防線**。

⚠️ **金鑰全程由你經手，客戶不碰。** 以下每一步都在你這邊做，交付給客戶的只有裝好的設定檔。

**① 產金鑰**（在你這邊產、裝完刪掉）

```bash
umask 077
wg genkey | tee site-<客戶代號>.key | wg pubkey > site-<客戶代號>.pub
```

**② 加進伺服器**——編輯 `/etc/wireguard/wg0.conf` 追加：

```ini
# 客戶：<客戶名稱>　新增日期：2026-08-14　經手：<你的名字>
[Peer]
PublicKey  = <site-<客戶代號>.pub 的內容>
AllowedIPs = 10.99.0.<N>/32
```

⚠️ **那行註解不是官僚。** 金鑰沒有「過期」這回事——**三年後你不會記得哪一組公鑰是哪個客戶的**，
而沒有註解就等於**沒辦法安全地移除任何一組**。

```bash
sudo systemctl reload wg-quick@wg0 || sudo systemctl restart wg-quick@wg0
sudo wg show
```

**③ 客戶端設定檔**（交給對方的閘道機／路由器）

```ini
[Interface]
Address    = 10.99.0.<N>/32
PrivateKey = <site-<客戶代號>.key 的內容>

[Peer]
PublicKey           = <伺服器的 server.pub>
Endpoint            = <VPS 公網 IP>:51820
AllowedIPs          = 10.99.0.1/32
PersistentKeepalive = 25
```

⚠️ `AllowedIPs` 只寫 `10.99.0.1/32`——**只有到伺服器的流量走隧道**，客戶自己的上網不受影響。
⚠️ `PersistentKeepalive` 是為了讓對方在 NAT 後面能維持連線，別省。

**④ 驗證，然後刪掉你手上的私鑰**

⚠️⚠️ **會很想留一份備用——不要留。**

客戶端全部由你經手，所以你手上會累積**每一個客戶場地的私鑰**。
⇒ **那個存放處會變成單點**：它被拿走一次，**等於所有客戶場地同時被拿走**。
單獨一把外洩只影響一個客戶；一份「全部的備份」外洩影響全部。**兩者差很多。**

**留著能省下的，只有換機時重簽的三分鐘**（見下一節）——**用那三分鐘換掉一個總開關，不划算。**

```bash
# 客戶端那側
ping 10.99.0.1
curl -s http://10.99.0.1:8787/health
```

```bash
# ⚠️ 確認通了之後，在你這邊刪掉
shred -u site-<客戶代號>.key
```

⇒ **私鑰不長期存在你這裡**：你產、你裝、確認通了就刪。之後那把只存在客戶端那台機器上。

## 客戶端換機或重灌

私鑰已經刪了也沒關係——**重簽比找備份快，而且更安全**。

```bash
# 1. 產新的一組
umask 077
wg genkey | tee site-<客戶代號>.key | wg pubkey > site-<客戶代號>.pub

# 2. 編輯 /etc/wireguard/wg0.conf：把該客戶那段 [Peer] 的 PublicKey 換成新的
#    ⚠️ AllowedIPs 的 10.99.0.<N> 沿用原本那個，不必改
sudo systemctl reload wg-quick@wg0 || sudo systemctl restart wg-quick@wg0

# 3. 新設定檔裝進新機器 → 驗證 → 刪掉手上的私鑰（同前一節第 ④ 步）
```

⚠️ **舊金鑰在第 2 步就自動失效了**（公鑰被換掉 ⇒ 舊私鑰再也連不進來）。
⇒ **舊機器若是報廢或遺失，這一步同時也完成了撤銷**，不必另外處理。

## 移除一個客戶場地

⚠️ **這一節最容易被略過，而且事後最難補。**
只要沒人把 peer 從設定移掉，**那組金鑰就永遠有效**——沒有自動過期。

```bash
# 1. 從 /etc/wireguard/wg0.conf 刪掉該 [Peer] 整段（連同上面那行註解）
sudo systemctl reload wg-quick@wg0 || sudo systemctl restart wg-quick@wg0

# 2. 確認真的不在了
sudo wg show | grep -A2 '<那組公鑰>'      # 應該查無
```

⇒ **結束合作、場地搬遷、金鑰外洩，三種情況都要做這一步。**

---

## 完成後的檢查清單

```bash
systemctl status wg-quick@wg0 server-foundation --no-pager   # 兩個都要 active
sudo wg show                                                  # peer 數量與預期相符
sudo ss -ltnp | grep -E '8787|3306|6379'                      # ⚠️ 見下
sudo firewall-cmd --list-ports                                # 應該只有 51820/udp
curl -s http://10.99.0.1:8787/health                          # 從 VPS 上打 WG 位址
```

⚠️ **第三行最重要**：`8787` 應該綁在 **`10.99.0.1`**，`3306`／`6379` 應該綁在 **`127.0.0.1`**。
**若看到任何一個是 `0.0.0.0`，立刻修**——不要因為「反正防火牆有擋」就放著，那是兩道防線只剩一道。

---

## ⚠️ 五個容易踩的坑

**① `HOST=0.0.0.0` 會把 API 暴露在公網。** 填 WG 介面位址。

**② 沒有代理卻開著 `TRUST_PROXY_HEADERS`** ⇒ 來源 IP 可被偽造 ⇒ 登入限流失效。

**③ `/usr/bin/node` 是寫死的**（systemd `ExecStart`）。用 nvm 會起不來，錯誤訊息只說找不到檔案。

**④ 備份寫不進去「不是 bug」，不要放寬 systemd 設定。**
unit 是 `ProtectSystem=strict` 且 `ReadWritePaths` 只列 `/var/lib/server-foundation`，
看起來備份目錄寫不進去——但**備份是 `scripts/backup.mjs` 獨立執行的、不是 API 服務在寫**
（整個 repo 查過，服務端沒有讀 `BACKUP_ROOT`）。
⇒ **把備份目錄加進 `ReadWritePaths` 只會削弱防護，不會修好任何東西。**

**⑤ MySQL 的 `localhost` 與 `127.0.0.1` 是兩個帳號。** 見步驟 4。

---

## 這份文件裡哪些是查證過的、哪些不是

**✅ 從 repo 實際檔案讀出來的**：所有版本號、`/usr/bin/node`、API 埠 `8787`、
十一個環境變數、目錄配置、備份由獨立腳本執行、`mysql2` 驅動與用到的 SQL 功能。

**⚠️ 未在 AlmaLinux 10 上實測**：`dnf module list nodejs` 有沒有 24、Percona 的 el10 套件、
SELinux 實際會擋哪一條。**這三處給的是「怎麼自己確認」，不是「照打就好」。**

**⚠️ 屬於設計判斷、不是查證**：一個場地一組金鑰（而非一台一組）、隧道內不再疊 TLS、
私鑰由你產完即刪。**這三項若你的實際情況不同，改它們不會破壞其他步驟。**

裝完若與這份不符，**以機器上看到的為準**，並回報我來更新。
