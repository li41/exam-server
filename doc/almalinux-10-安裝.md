# AlmaLinux 10 全新機器 → 可以跑 `deploy/README.md` 的狀態

**架構：院內服務，只從 WireGuard 隧道進來，連內網的 TCP 埠都不開。**

⚠️ 使用者是**國教院內部的桌面版後台**（約 20 台），伺服器也在院內。
**考試端（考生應試）在 Cloudflare，不經過這台機器**——不要把兩者混為一談。

## ⚡ 想直接跑的話：有一支腳本把步驟 1-9 做完了

```bash
bash deploy/scripts/bootstrap-almalinux10.sh
```

可重複執行、每步做完就驗、驗不過就停；**不含任何密碼，一律互動式 `sudo`**。
預設 `PORT=18787`（⚠️ 刻意不是 8787，理由見步驟 9）。

⇒ **這份文件仍然要讀**——腳本做了什麼、為什麼那樣做、哪裡會靜默失效，都寫在下面。
**腳本是省打字的，不是省理解的。**

---

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
院內網路
┌────────────────────────────────────────────────────────────┐
│  桌面版後台 ×20（Windows）                                   │
│        │                                                    │
│        │ WireGuard（UDP 51820）                             │
│        ▼                                                    │
│  exam-server（院內這台）                                     │
│        10.99.0.1:8787  Node API（綁 WG 介面 ★）             │
│                  ├─► MySQL  127.0.0.1:3306                 │
│                  └─► Redis  127.0.0.1:6379                 │
└────────────────────────────────────────────────────────────┘
        ✂ 院內網段掃不到任何 TCP 服務
```

## 為什麼是這個架構（2026-08-14 主公 裁示，理由值得記）

**選它的理由是資安稽核，不是效能也不是成本。**

⚠️ **稽核時要這樣講，不要講「什麼都沒開」**（那句不精確、會被追問）：

> **`exam-server` 的 TCP 8787 不對院內實體網卡暴露。**
> 院內只開 **WireGuard UDP 51820**，**8787 僅可經由 WireGuard overlay 存取。**

⇒ 對照「開 443 但有做認證」：那是**有一個服務在聽、靠應用層擋**；
這裡是**那個服務在院內網段上不存在**，要先通過裝置層的金鑰驗證才看得到它。

⚠️ **UDP 51820 是開著的**——WireGuard 本來就是走 UDP。
它的性質是**對未授權封包完全不回應**（連 RST 都沒有），所以掃描器看不出後面有什麼，
**但它不是「沒有開埠」。** 講成「什麼都沒開」在稽核上站不住。

### ⭐ 連帶好處：憑證問題整個消失

WireGuard 本身就在加密（ChaCha20-Poly1305）⇒ **隧道內不需要再上 TLS**：

- ❌ 不用 Let's Encrypt——院內機器打不到，HTTP-01 本來就驗不過
- ❌ 不用 DNS-01，**不用去要能改 `naer.edu.tw` 的 API token**
- ❌ 不用內部 CA，**不用在 20 台桌面裝信任根**
- ❌ **不需要反向代理**（Caddy／OpenResty 存在的主要理由就是 TLS 終結）

⇒ **比公開 HTTPS 版少一個元件，也少一整條憑證續期的維運線。**
稽核時「傳輸加密」的答案是 WireGuard 本身，不是一張三個月要續一次的憑證。

### ⚠️ 這個架構唯一會**靜默失效**的地方

**API 綁在哪個位址，決定上面那些好處是真的還是假的。** 見步驟 9 的 `HOST`。

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

⚠️ **2026-08-14 在 AlmaLinux 10.2 實機查證，本節原本寫錯，已更正**：

- ❌ **`dnf module list nodejs` 會直接報 `Error: No matching Modules to list`**
  ——**RHEL 10／AlmaLinux 10 取消了 dnf modularity**，那條分支不存在。
- ❌ AppStream 只有 **`nodejs 22.23.1`**，沒有 24。

⇒ **只有一條路：NodeSource。**（已驗 `pub_24.x/nodistro/nodejs/x86_64/repodata/repomd.xml` 回 200）

```bash
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf -y install nodejs
```

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

⚠️ **套件名是 `mysql8.4-server`，不是 `mysql-server`**（2026-08-14 實機查證）。
AlmaLinux 10 的 AppStream **沒有** `mysql-server` 這個名字，只有帶版號的 `mysql8.4-server`（實測 8.4.9）。

```bash
sudo dnf -y install mysql8.4-server && sudo systemctl enable --now mysqld && sudo mysql_secure_installation
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

## 步驟 5：Valkey（**不是 Redis**）

🔴 **2026-08-14 實機查證：AlmaLinux 10 的 repo 裡沒有 `redis` 這個套件。**
RHEL 10 因為 Redis 的授權變更把它移除了，官方替代是 **Valkey**（Redis 的分支，協定相容）。實測有 `valkey 8.0.9`。

```bash
sudo dnf -y install valkey
```

`/etc/valkey/valkey.conf`：`bind 127.0.0.1 -::1`、`protected-mode yes`

```bash
sudo systemctl enable --now valkey && valkey-cli ping     # PONG
```

⚠️ **未確認**：本專案的 redis adapter（`packages/adapters/redis`）對 **Valkey 8 的相容性尚未實測**。
理論上協定相容，但**沒跑過就是沒跑過**。
⇒ 若日後出現協定層問題，替代方案是從 **Remi／EPEL** 裝原生 Redis。**發現問題請回報我更新這一節。**

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

# ── 桌面電腦從這裡往下加，一台一段（見〈新增一台桌面電腦〉）──
```

```bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show                      # 看得到 interface 就對了
ip -brief addr show wg0           # 應該看到 10.99.0.1/24
```

⚠️ **不需要開 IP 轉發**。桌面版只連這台機器上的 API，不是把這台當跳板出去。
`net.ipv4.ip_forward` **維持關閉**——開了等於讓 20 台桌面能透過這台互連。

## 步驟 7：防火牆——**只開 UDP 51820**

```bash
sudo firewall-cmd --permanent --add-port=51820/udp
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

⚠️ **不要開 80／443／8787／3306／6379。**
院內網段掃描只會看到一個 UDP 埠，而且 WireGuard **不回應未經認證的封包**。
⇒ **這一步就是整個架構的稽核價值所在**，開了任何一個 TCP 埠就等於白做。

⚠️ **SSH（22）怎麼辦**：這台你自己要能管。院內既有的管理途徑（跳板機／院內網段）照貴院規範走，
**但不要為了方便把 8787 一起開**——管理通道與服務通道是兩件事。

### ⭐ 再加一道：**明訂 8787 只准從 wg0 進來**

上面的 `HOST=10.99.0.1` 已經讓 API 不聽實體網卡，但那**只有一道，而且會靜默失效**（見步驟 9）。
⇒ **防火牆再擋一次，變成兩道獨立防線**：

```bash
# 把 wg0 劃進獨立 zone，只有它能碰 8787
sudo firewall-cmd --permanent --zone=trusted --add-interface=wg0
sudo firewall-cmd --permanent --zone=trusted --add-port=8787/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --zone=trusted --list-all      # 應看到 wg0 與 8787/tcp
```

⚠️ **關鍵在於 `--zone=trusted` 綁的是 `wg0` 這個介面**，不是某個 IP 範圍——
**介面是實打實的隧道出口**，不會因為有人偽造來源位址就繞過。

⇒ 之後就算哪天有人把 `HOST` 改成 `0.0.0.0`，**防火牆仍然擋著**，
不會像現在這樣「改錯了完全沒有徵兆」。**這一步花三十秒，換掉一個靜默失效點。**

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

⚠️⚠️⚠️ **`HOST` 絕對不要填 `0.0.0.0`——這是整份文件裡最重要的一行。**

```
HOST = 10.99.0.1     ← wg0 介面位址 ✅
HOST = 0.0.0.0       ← ❌ 服務照樣開在院內網段上
```

填 `0.0.0.0` 的話，**API 會同時綁上院內網卡**——防火牆擋得住外面，但**院內任何一台機器都連得到 8787**。

⇒ **那正是你選這個架構要省掉的東西。** 而且它**不會有任何錯誤訊息**：
隧道照樣通、桌面版照樣能用、一切看起來都對，**只有稽核那一格從「沒有服務」變回「有一個沒認證的服務」**。

⚠️ **這是本架構唯一會靜默失效的地方。** 裝完務必跑〈完成後的檢查清單〉第三行確認。

其餘九個照範本填：`NODE_ENV`、`PORT`、`MYSQL_URL`、`REDIS_URL`、`FILE_STORAGE_ROOT`、
`FILE_CLEANUP_INTERVAL_SECONDS`、`IDEMPOTENCY_TTL_SECONDS`、`SHUTDOWN_TIMEOUT_SECONDS`、`BACKUP_ROOT`。

---

## 金鑰名冊——**20 台的規模，這一件必須先決定**

**一台桌面電腦一組金鑰**（不是一個人一組、也不是全院共用一組）。
⇒ 撤銷時對應到的是**硬體**：那台報廢、遺失、重灌，就撤那一組，不牽動其他人。

⚠️ **金鑰沒有「過期」這回事。** 一組公鑰只要還在 `wg0.conf` 裡就永遠有效。
⇒ **三年後你不會記得哪一組公鑰是哪一台**，而沒有名冊就等於**沒辦法安全地移除任何一組**。

**名冊就是 `wg0.conf` 裡的註解**，每段 `[Peer]` 上面一行，格式固定：

```ini
# 10.99.0.11  資源中心 PC-07  資產編號 NAER-2024-0731  裝機 2026-08-14  經手 <你的名字>
```

⚠️ **不要另外開一份 Excel。** 兩份會不同步，而**設定檔才是唯一真的在生效的那份**。

**IP 配發建議**：`10.99.0.11` 起連號給桌面機，**`10.99.0.2-10` 留給你自己的管理機**。
（20 台用不到一個 /24 的一半，不必省。）

---

## 新增一台桌面電腦

⚠️ **金鑰全程由你經手，使用者不碰。** 交付給使用者的只有裝好的設定檔。

**① 產金鑰**（在你這邊產、裝完刪掉）

```bash
umask 077
wg genkey | tee pc-<編號>.key | wg pubkey > pc-<編號>.pub
```

**② 加進伺服器**——編輯 `/etc/wireguard/wg0.conf` 追加：

```ini
# 10.99.0.<N>  <位置/機器名>  資產編號 <…>  裝機 <日期>  經手 <你的名字>
[Peer]
PublicKey  = <pc-<編號>.pub 的內容>
AllowedIPs = 10.99.0.<N>/32
```

⚠️⚠️ **`AllowedIPs` 一定要 `/32`，不能寫成 `/24`。**
寫 `/24` 等於允許那一台冒用**任何一台**的隧道位址 ⇒ 你就再也分不出來源是誰，
**登入限流與稽核日誌會一起失去意義**。20 個 peer 就要 20 個 `/32`。

```bash
sudo systemctl reload wg-quick@wg0 || sudo systemctl restart wg-quick@wg0
sudo wg show
```

**③ 桌面端設定檔**（Windows 版 WireGuard，`匯入通道` 讀這個檔）

```ini
[Interface]
Address    = 10.99.0.<N>/32
PrivateKey = <pc-<編號>.key 的內容>

[Peer]
PublicKey           = <伺服器的 server.pub>
Endpoint            = <伺服器的院內 IP>:51820
AllowedIPs          = 10.99.0.1/32
PersistentKeepalive = 25
```

⚠️ **`Endpoint` 填院內 IP，不是公網 IP**——伺服器就在院內，流量不出大樓。
⚠️ `AllowedIPs` 只寫 `10.99.0.1/32`——**只有到這台伺服器的流量走隧道**，使用者上網與院內其他系統不受影響。
（寫成 `0.0.0.0/0` 會把整台電腦的網路都導進隧道，**那會弄壞使用者的其他工作**。）
⚠️ `PersistentKeepalive` 別省——院內若有防火牆做連線狀態追蹤，閒置久了會斷。

**④ 驗證，然後刪掉你手上的私鑰**

```powershell
# 桌面端（PowerShell）
ping 10.99.0.1
curl.exe -s http://10.99.0.1:8787/health
```

```bash
# ⚠️ 確認通了之後，在你這邊刪掉
shred -u pc-<編號>.key
```

⚠️⚠️ **會很想留一份備用——不要留。**

20 台全由你經手，所以你手上會累積 **20 把私鑰**。
⇒ **那個存放處會變成單點**：它被拿走一次，**等於 20 台同時被拿走**。
單獨一把外洩只影響一台；一份「全部的備份」外洩影響全部。**兩者差很多。**

**留著能省下的，只有換機時重簽的三分鐘**（見下節）——**用那三分鐘換掉一個總開關，不划算。**

### 📦 分工：**使用者自己裝軟體，你只出設定檔**（2026-08-14 主公 確認）

- **使用者自己做**：到 wireguard.com 下載 Windows 版、安裝（標準安裝程式、下一步到底）
- **你做**：產金鑰 → 登記進 `wg0.conf` → **把那台專屬的 `.conf` 給他** → 他按「匯入通道」

⇒ **你不必寫任何安裝腳本、不必進到每一台機器上。**

⚠️ **但設定檔必須一台一份。** 絕不要把同一份 `.conf` 發給多人——
那等於 20 台共用一把金鑰，**撤銷時只能全部一起撤**，稽核日誌也分不出是誰。

⚠️ **設定檔裡有私鑰** ⇒ **不要用公司群組信箱、共用資料夾、Teams 群組頻道發**。
一對一給，給完請對方確認匯入成功，**然後你把手上那份刪掉**（第 ④ 步）。

---

## 桌面電腦換機或重灌

私鑰已經刪了也沒關係——**重簽比找備份快，而且更安全**。

```bash
# 1. 產新的一組
umask 077
wg genkey | tee pc-<編號>.key | wg pubkey > pc-<編號>.pub

# 2. 編輯 /etc/wireguard/wg0.conf：把該台那段 [Peer] 的 PublicKey 換成新的
#    ⚠️ AllowedIPs 的 10.99.0.<N> 沿用原本那個，不必改
#    ⚠️ 註解那行的「裝機日期」也順手更新
sudo systemctl reload wg-quick@wg0 || sudo systemctl restart wg-quick@wg0

# 3. 新設定檔裝進新機器 → 驗證 → 刪掉手上的私鑰（同前節第 ④ 步）
```

⚠️ **舊金鑰在第 2 步就自動失效了**（公鑰被換掉 ⇒ 舊私鑰再也連不進來）。
⇒ **舊機器若是報廢或遺失，這一步同時也完成了撤銷**，不必另外處理。

## 移除一台桌面電腦

⚠️ **這一節最容易被略過，而且事後最難補。**
只要沒人把 peer 從設定移掉，**那組金鑰就永遠有效**——沒有自動過期。

```bash
# 1. 從 /etc/wireguard/wg0.conf 刪掉該 [Peer] 整段（連同上面那行註解）
sudo systemctl reload wg-quick@wg0 || sudo systemctl restart wg-quick@wg0

# 2. 確認真的不在了
sudo wg show | grep -A2 '<那組公鑰>'      # 應該查無
```

⇒ **電腦報廢、人員離職、機器遺失，三種情況都要做這一步。**
⚠️ **離職特別容易漏**：人走了帳號停用了，**但那台電腦上的隧道金鑰還在**。
帳號停用擋得住登入，**但 API 表面又對那台開著了**——那正是你想省掉的東西。

---

## 完成後的檢查清單

```bash
systemctl status wg-quick@wg0 server-foundation --no-pager   # 兩個都要 active
sudo wg show                                                  # peer 數量與預期相符
sudo ss -ltnp | grep -E '8787|3306|6379'                      # ⚠️ 見下
sudo firewall-cmd --list-ports                                # 應該只有 51820/udp
curl -s http://10.99.0.1:8787/health                          # 從 VPS 上打 WG 位址
```

⚠️⚠️ **第三行最重要，而且它是唯一驗得出「靜默失效」的一步**：

```
✅ 對的樣子    10.99.0.1:8787    127.0.0.1:3306    127.0.0.1:6379
❌ 錯的樣子    0.0.0.0:8787      ← 服務仍在院內網段上
```

**看到任何一個是 `0.0.0.0`，立刻修。**
⚠️ 不要因為「反正防火牆有擋」就放著——**防火牆擋的是外面，`0.0.0.0` 開的是裡面**，
而你選這個架構要省掉的，正好就是「院內有服務在聽」這一格。

⚠️ **這一項要在每次改 env 或升版之後重跑**，不是只在裝機時跑一次。

---

## ⚠️ 五個容易踩的坑

**① `HOST=0.0.0.0` 會把 API 開在院內網段上。** 填 WG 介面位址 `10.99.0.1`。
⚠️ **不會有任何錯誤訊息**——一切照常運作，只有稽核那一格默默失守。

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

**✅ 2026-08-14 在 AlmaLinux 10.2 實機查證（原本標「未實測」的，三處全查了、三處全錯，已更正）**：

| 原本寫 | 實機結果 |
|---|---|
| `dnf module list nodejs` 看有沒有 24 | ❌ **el10 取消 modularity，指令直接報錯**；AppStream 只有 nodejs 22 ⇒ 只能走 NodeSource |
| `mysql-server` | ❌ **不存在**，實際是 `mysql8.4-server`（8.4.9） |
| `redis` | ❌ **RHEL 10 已移除**，改 `valkey`（8.0.9） |

⇒ **這三格教訓一樣**：文件裡「照 CI image 的版本推測套件名」是不可靠的，**要在目標發行版上實查**。
另：`wireguard-tools`（1.0.20250521）與 `firewalld`（2.4.3）**都在，但 firewalld 預設未安裝**。

**⚠️ 仍未實測**：
- **Percona 的 el10 套件**（本輪沒裝，走原廠 `mysql8.4-server`）
- **SELinux 實際會擋哪一條**——⚠️ 而且 **AlmaLinux WSL 映像未安裝 `selinux-policy`**，
  ⇒ **這一項在 WSL 上驗不到，必須在正式機重做。**
- **本專案的 redis adapter 對 Valkey 的相容性**（見步驟 5）

**⚠️ 屬於設計判斷、不是查證**：一台電腦一組金鑰、`AllowedIPs` 用 `/32`、
隧道內不再疊 TLS、私鑰由你產完即刪、IP 從 `.11` 起配。
**這五項若實際情況不同，改它們不會破壞其他步驟**（`/32` 那項除外，理由寫在該處）。

**⚠️ 屬於主公 裁示、不是我的建議**（2026-08-14 議事廳）：
走 WireGuard 而非公開 HTTPS 或限網段（**理由是資安稽核：連內網 TCP 埠都不用開**）；
API 綁 VPN 網段；**軟體由使用者自行安裝、不做派送**。

### 這份文件先前繞過的兩版（避免有人再問一次）

1. **公開 HTTPS＋Caddy／OpenResty** — 對外服務才需要，本案是院內服務，不適用。
2. **限院內網段的白名單** — 比 VPN 省事，但**仍要開 TCP 埠**，稽核上省不掉那一格。

⇒ **決定的關鍵不是「哪個比較安全」，是「哪個在稽核時最好交代」。** 三種都能擋住攻擊者，
但只有 WireGuard 這版能回答「**TCP 8787 不對院內實體網卡暴露，只可經 overlay 存取**」。
⚠️ **不要簡化成「什麼都沒開」**——UDP 51820 是開著的，見〈為什麼是這個架構〉那節。

裝完若與這份不符，**以機器上看到的為準**，並回報我來更新。
