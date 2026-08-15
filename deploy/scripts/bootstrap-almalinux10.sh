#!/usr/bin/env bash
#
# AlmaLinux 10：全新機器 → 可以登入的 server-foundation
#
# 這支是**完整安裝**，一條命令從空機器裝到 API 在聽、有第一個帳號。
# 可重複執行（idempotent）：重跑不會蓋掉金鑰、peer 名冊、既有密碼或既有帳號。
#
# 用法：
#   bash deploy/scripts/bootstrap-almalinux10.sh                # 全套
#   SF_PORT=18787 SF_WG_ADDR=10.99.0.1 bash deploy/scripts/...  # 換參數
#   SF_STOP_AFTER=system bash deploy/scripts/...                # 只裝系統，不裝 app
#
# ⚠️ 這支不含任何密碼，一律走互動式 sudo。不要把密碼寫進這個檔或任何檔案。
# ⚠️ 每一步做完就驗，驗不過就停。「沒報錯」不算通過。
#
# 對照文件：doc/almalinux-10-安裝.md
#
# ──────────────────────────────────────────────────────────────
# 實測修正（2026-08-14 於 AlmaLinux 10.2，與文件初稿不符之處）
#   1. el10 沒有 dnf modularity ⇒ `dnf module list nodejs` 直接報錯，只能走 NodeSource
#   2. 套件叫 `mysql8.4-server`（不是 `mysql-server`）
#   3. RHEL 10 移除 Redis ⇒ 改用 `valkey`（Redis 相容分支）
#   4. firewalld 預設未安裝
#
# ──────────────────────────────────────────────────────────────
# 關於 SELinux（主公 2026-08-15 裁定：不用，正式機也會關）
#
#   本腳本**不啟用也不檢查 SELinux**。這是明示的取捨，不是遺漏：
#   放棄的是「服務被入侵後還有一層強制存取控制」，換來的是不必處理
#   標籤問題。因此本架構的邊界完全落在 WireGuard ＋ firewalld ＋
#   HOST 綁定這三者上 ⇒ **步驟 6、7 與最後的監聽位址檢查不能省**。
#
# 關於「PHP 那種更新後 session 權限就變」（主公 2026-08-14 問）
#
#   本系統 session 存在 Redis/Valkey、**不是檔案** ⇒ 沒有 PHP 那個問題。
#   同類陷阱剩兩個，這支都處理了：
#     A. /var/lib/server-foundation/storage 是 0700 且屬 server-foundation。
#        任何用 root 在裡面建檔的動作，都會讓服務讀不到自己的檔案。
#     B. systemd unit 寫死 /usr/bin/node ⇒ 用 nvm 之類換裝 Node 就起不來，
#        而錯誤訊息只說找不到檔案。
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# ── 可調參數 ───────────────────────────────────────────────────
SF_PORT="${SF_PORT:-18787}"          # ⚠️ 預設刻意不是 8787，理由見步驟 0
SF_HOST="${SF_HOST:-127.0.0.1}"      # ⚠️ 正式機要改成 WireGuard 介面位址，絕不可填 0.0.0.0
SF_WG_ADDR="${SF_WG_ADDR:-10.99.0.1}"
SF_WG_CIDR="${SF_WG_CIDR:-10.99.0.1/24}"
SF_WG_PORT="${SF_WG_PORT:-51820}"
SF_DB_NAME="${SF_DB_NAME:-server_foundation}"
SF_DB_USER="${SF_DB_USER:-server_foundation}"
SF_SETUP_WIREGUARD="${SF_SETUP_WIREGUARD:-1}"
SF_SETUP_FIREWALL="${SF_SETUP_FIREWALL:-1}"
SF_ADMIN_EMAIL="${SF_ADMIN_EMAIL:-}"        # 空＝跳過建帳號
SF_ADMIN_ROLES="${SF_ADMIN_ROLES:-developer}"
SF_TENANT_ID="${SF_TENANT_ID:-}"            # 空＝自動產一個 UUID
SF_STOP_AFTER="${SF_STOP_AFTER:-all}"       # system | all

ENV_FILE=/etc/server-foundation/server-foundation.env
SERVICE_USER=server-foundation
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── 輸出 ──────────────────────────────────────────────────────
step() { printf '\n\033[1;36m━━ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

# ⚠️⚠️ firewalld 一旦啟用，**服務會連不上自己的資料庫**，除非明確放行 loopback。
#    症狀：應用程式打 127.0.0.1:3306 得到 errno 113（EHOSTUNREACH），
#          看起來像 MySQL 沒開，其實是被 REJECT。
#
#    2026-08-15 實測（AlmaLinux 10.2）兩種寫法的差別：
#      --add-interface=lo        ❌ 這台無效
#      --add-source=127.0.0.0/8  ✅ 有效
#    原因：這台除了 lo 還有 loopback0（WSL mirrored networking 生的），
#    流量走的不是 lo ⇒ 介面比對不中，來源位址比對才中。
#    ⚠️ 正式機（沒有 loopback0）慣例上 lo 規則就夠了，但來源規則在兩邊都成立且無害
#    ——來源 127/8 的封包本來就不可能從外網進來（核心的 martian 過濾會先擋掉）。
#    ⇒ 兩個都加。
#
#    ⚠️ 這個函式在步驟 5（測資料庫前）與步驟 8（設定防火牆時）各叫一次：
#    重跑時 firewalld 已經在跑，若只在步驟 8 才修，步驟 5 就先死了。
ensure_loopback_trusted() {
  command -v firewall-cmd >/dev/null 2>&1 || return 0
  systemctl is-active --quiet firewalld 2>/dev/null || return 0
  sudo firewall-cmd --permanent --zone=trusted --add-interface=lo >/dev/null 2>&1 || true
  sudo firewall-cmd --permanent --zone=trusted --add-source=127.0.0.0/8 >/dev/null 2>&1 || true
  sudo firewall-cmd --reload >/dev/null 2>&1 || true
}

# ⚠️ 這支會多次 sudo。先要一次，之後才不會在中途卡住等密碼。
sudo -v || die "需要 sudo 權限"

[ -f "$REPO_DIR/package.json" ] || die "找不到 repo 根目錄（推得的是 $REPO_DIR）"
ok "repo: $REPO_DIR"

if is_wsl; then
  warn "偵測到 WSL。以下兩項在這裡驗不到，正式機必須重跑一次："
  warn "  ① 防火牆作為真實邊界"
  warn "  ② 「院內網段掃不到任何 TCP 服務」這個稽核性質"
fi

# ══════════════════════════════════════════════════════════════
step "步驟 0：埠號預檢（⚠️ 這一步擋掉最惡劣的失敗形狀）"
# 8787 在主公這台被逸策台 daemon 佔著，而 **那支的 /health 也回 200**。
# 若沿用 8787，健康檢查會拿到 200 而你以為 exam-server 起來了——
# 實際上在跟一個完全無關的程式講話。這是「看起來成功」的失敗，最難發現。
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${SF_PORT}\$"; then
  # 已經裝過並在跑的情況要放行，否則這支就不能重跑了
  if systemctl is-active --quiet server-foundation 2>/dev/null; then
    ok "埠 ${SF_PORT} 被 server-foundation 自己佔著（重跑情境，放行）"
  else
    die "埠 ${SF_PORT} 已被別的程式佔用。換一個：SF_PORT=<其他> 重跑。"
  fi
else
  ok "埠 ${SF_PORT} 空著"
fi

# ══════════════════════════════════════════════════════════════
step "步驟 1：系統基礎"
sudo dnf -y update
sudo dnf -y install curl tar ca-certificates
sudo timedatectl set-timezone Asia/Taipei 2>/dev/null || warn "時區設定失敗（WSL 常見，可忽略）"
ok "系統套件與時區"

# ══════════════════════════════════════════════════════════════
step "步驟 2：Node 24"
# ⚠️ AlmaLinux 10 沒有 dnf modularity，`dnf module list nodejs` 會直接報
#    「No matching Modules to list」。AppStream 只有 nodejs 22。
#    ⇒ Node 24 只能走 NodeSource（2026-08-14 實測 repodata 有效）。
if command -v node >/dev/null && node -v | grep -q '^v24\.'; then
  ok "Node $(node -v) 已安裝"
else
  curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
  sudo dnf -y install nodejs
fi
node -v | grep -q '^v24\.' || die "Node 版本不是 24：$(node -v)"
# ⚠️ systemd unit 的 ExecStart 寫死 /usr/bin/node，路徑不對服務就起不來
[ "$(command -v node)" = /usr/bin/node ] \
  || die "node 不在 /usr/bin/node（實際：$(command -v node)）。systemd unit 寫死該路徑。"
ok "Node $(node -v) @ /usr/bin/node"

# ══════════════════════════════════════════════════════════════
step "步驟 3：pnpm"
# ⚠️ 這台**一定要有 pnpm**，不是可選的：
#    install-release.sh:45-46 在目標機上跑
#      corepack pnpm --dir <target> install --prod --frozen-lockfile
#      corepack pnpm --dir <target> --filter @server-foundation/mysql-adapter migrate
#    ⇒ 沒有 pnpm 就無法安裝 release、也無法跑 migration。
#    （這支腳本先前版本寫「可在別處打包所以不必裝 pnpm」——那是錯的。）
sudo corepack enable 2>/dev/null || sudo npm i -g corepack
corepack prepare pnpm@11.10.0 --activate >/dev/null 2>&1 || true
corepack pnpm -v >/dev/null 2>&1 || die "pnpm 不可用"
ok "pnpm $(corepack pnpm -v)"

# ══════════════════════════════════════════════════════════════
step "步驟 4：MySQL 8.4"
# ⚠️ 套件名是 mysql8.4-server，不是 mysql-server（後者在 el10 不存在）
if ! rpm -q mysql8.4-server >/dev/null 2>&1; then
  sudo dnf -y install mysql8.4-server
fi
sudo systemctl enable --now mysqld
sudo systemctl is-active --quiet mysqld || die "mysqld 未啟動"
ok "MySQL $(mysql --version 2>/dev/null | grep -oE '8\.[0-9.]+' | head -1)"

# ══════════════════════════════════════════════════════════════
step "步驟 5：資料庫、應用帳號、環境檔"

# ⚠️ 密碼字元集刻意限制在 [A-Za-z0-9]：MYSQL_URL 是 URL，
#    密碼含 @ : / # ? 會被解析成 URL 結構而不是密碼，
#    症狀是「密碼明明對卻 access denied」，極難查。
gen_password() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32; }

# ⚠️ 服務帳號要先建，/etc/server-foundation 的 group 才設得起來
id -u "$SERVICE_USER" >/dev/null 2>&1 \
  || sudo useradd --system --home /var/lib/server-foundation --shell /sbin/nologin "$SERVICE_USER"
sudo install -d -m 0750 -o root -g "$SERVICE_USER" /etc/server-foundation

# 重跑時沿用既有密碼；否則產新的。
# ⚠️ 不沿用會壞事：env 換了新密碼、DB 帳號還是舊的 ⇒ 重跑一次就把自己鎖在外面。
DB_PASSWORD=""
# ⚠️⚠️ 一定要 `sudo test -f`，不能用 `[ -f ]`。
#    ENV_FILE 在 /etc/server-foundation（0750 root:server-foundation）底下，
#    一般使用者對該目錄沒有 x 權限 ⇒ **`[ -f ]` 一律回假**，
#    於是這整段「沿用既有密碼」永遠不會觸發，每次重跑都換新密碼、把自己鎖在外面。
#    2026-08-15 實測就是這樣壞的：檢查方法本身看不到它要找的東西。
if sudo test -f "$ENV_FILE"; then
  existing="$(sudo grep -E '^MYSQL_URL=' "$ENV_FILE" 2>/dev/null || true)"
  if [ -n "$existing" ] && ! printf '%s' "$existing" | grep -q 'CHANGE_ME'; then
    DB_PASSWORD="$(printf '%s' "$existing" | sed -E 's|^MYSQL_URL=mysql://[^:]+:([^@]*)@.*$|\1|')"
    [ -n "$DB_PASSWORD" ] && ok "沿用 ${ENV_FILE} 既有的資料庫密碼"
  fi
fi
if [ -z "$DB_PASSWORD" ]; then
  DB_PASSWORD="$(gen_password)"
  ok "已產生新的資料庫密碼（只寫進 ${ENV_FILE}，不顯示、不留 log）"
fi

# ⚠️⚠️ MySQL 的 'user'@'localhost' 與 'user'@'127.0.0.1' 是**兩個不同帳號**，
#    而「連線字串寫 127.0.0.1 就該建 @'127.0.0.1'」是**錯的**：
#    MySQL 預設 skip_name_resolve=OFF ⇒ 它會把來源 IP **反解成主機名**再比對，
#    127.0.0.1 反解成 localhost ⇒ 實際比對到的是 @'localhost'。
#    2026-08-15 實測：只建 @'127.0.0.1' 會得到
#      ERROR 1045 Access denied for user 'x'@'localhost'
#    ——訊息裡的 'localhost' 就是證據，但很容易被當成「我明明連的是 127.0.0.1」而看漏。
#    ⇒ **兩個都建**，這樣 skip_name_resolve 開或關都能連。
# ⚠️ 密碼經 stdin 餵進去，不出現在命令列（ps 看得到命令列參數）。
sudo mysql --connect-expired-password <<EOSQL || die "無法以 root 連線 MySQL。請先跑 mysql_secure_installation 或確認 socket 認證。"
CREATE DATABASE IF NOT EXISTS \`${SF_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${SF_DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${SF_DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL ON \`${SF_DB_NAME}\`.* TO '${SF_DB_USER}'@'127.0.0.1';
CREATE USER IF NOT EXISTS '${SF_DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${SF_DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL ON \`${SF_DB_NAME}\`.* TO '${SF_DB_USER}'@'localhost';
FLUSH PRIVILEGES;
EOSQL
ok "資料庫 ${SF_DB_NAME} 與帳號 ${SF_DB_USER}@{127.0.0.1,localhost}"

MYSQL_URL_VALUE="mysql://${SF_DB_USER}:${DB_PASSWORD}@127.0.0.1:3306/${SF_DB_NAME}"

# ⚠️ 獨立驗證：不要相信 GRANT 沒報錯就等於連得上。用真的應用帳號連一次。
# ⚠️ 密碼絕不可走 `-p<密碼>` —— 命令列參數任何人 `ps` 都看得到。走 0600 的暫存設定檔。
MYCNF="$(mktemp)"
chmod 0600 "$MYCNF"
trap 'rm -f "$MYCNF"' EXIT
printf '[client]\nuser=%s\npassword=%s\n' "$SF_DB_USER" "$DB_PASSWORD" > "$MYCNF"
# ⚠️ 重跑情境：firewalld 可能已經在跑並擋著 loopback ⇒ 先放行再測，否則必死於 2003
ensure_loopback_trusted

# ⚠️ **不要吞 stderr**。這裡的兩種失敗長得一樣但成因天差地遠：
#      ERROR 2003 ... (113)  ＝ 連不到（EHOSTUNREACH，多半是防火牆擋 loopback）
#      ERROR 1045 ...        ＝ 連得到但認證失敗（帳號主機名不對）
#    先前這行寫 2>&1 到 /dev/null，害我拿著「實連失敗」四個字查錯方向。
if ! DBERR="$(mysql --defaults-extra-file="$MYCNF" --protocol=TCP -h 127.0.0.1 \
                    -e "USE \`${SF_DB_NAME}\`; SELECT 1;" 2>&1)"; then
  printf '  實際錯誤：%s\n' "$(printf '%s' "$DBERR" | head -2)"
  die "應用帳號連不上資料庫（錯誤原文在上一行，2003＝網路被擋、1045＝帳號主機名不對）"
fi
rm -f "$MYCNF"; trap - EXIT
ok "已用應用帳號實連驗證通過"

# ══════════════════════════════════════════════════════════════
step "步驟 6：Valkey（RHEL 10 的 Redis 替代）"
# ⚠️ RHEL/AlmaLinux 10 已移除 redis 套件，改提供 valkey（Redis 相容分支）。
if ! rpm -q valkey >/dev/null 2>&1; then
  sudo dnf -y install valkey
fi
sudo systemctl enable --now valkey
sudo systemctl is-active --quiet valkey || die "valkey 未啟動"
{ redis-cli ping 2>/dev/null || valkey-cli ping 2>/dev/null; } | grep -q PONG \
  || die "valkey 無回應"
ok "Valkey 已啟動並回 PONG"

# ══════════════════════════════════════════════════════════════
if [ "$SF_SETUP_WIREGUARD" = "1" ]; then
  step "步驟 7：WireGuard（伺服器端）"
  sudo dnf -y install wireguard-tools
  if [ ! -f /etc/wireguard/server.key ]; then
    sudo install -d -m 0700 /etc/wireguard
    # ⚠️⚠️ umask 一定要關在子 shell 裡。
    #    2026-08-15 實測：原本這裡是裸的 `umask 077`，**一路漏到步驟 10 的 pnpm build**，
    #    於是所有建置產物變成 0600 ⇒ 打包進 tarball ⇒ 解開後服務帳號讀不到自己的程式。
    #    ⚠️ 而 Node 對「讀不到」報的是 `MODULE_NOT_FOUND`，
    #       看起來像檔案不存在，實際上檔案就在那裡、只是沒權限。
    (
      umask 077
      wg genkey | sudo tee /etc/wireguard/server.key >/dev/null
      sudo chmod 0600 /etc/wireguard/server.key
      sudo sh -c 'wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub'
    )
    ok "已產伺服器金鑰對"
  else
    ok "伺服器金鑰已存在（不覆蓋）"
  fi

  if [ ! -f /etc/wireguard/wg0.conf ]; then
    sudo sh -c "cat > /etc/wireguard/wg0.conf" <<EOWG
[Interface]
Address    = ${SF_WG_CIDR}
ListenPort = ${SF_WG_PORT}
PostUp     = chmod 0640 /etc/wireguard/wg0.conf
PrivateKey = $(sudo cat /etc/wireguard/server.key)

# ── 桌面電腦從這裡往下加，一台一段 ──
# 名冊就寫在每段 [Peer] 上面這行註解，格式固定：
# 10.99.0.11  <位置/機器名>  資產編號 <…>  裝機 <日期>  經手 <…>
# ⚠️ AllowedIPs 一定要 /32。寫 /24 等於允許那台冒用任何一台的隧道位址，
#    登入限流與稽核日誌會一起失去意義。
EOWG
    sudo chmod 0600 /etc/wireguard/wg0.conf
    ok "已建立 wg0.conf"
  else
    ok "wg0.conf 已存在（不覆蓋，避免蓋掉既有 peer）"
  fi

  # ⚠️ 不開 IP 轉發：桌面版只連這台的 API，不是把這台當跳板。
  #    開了等於讓 20 台桌面能透過這台互連。
  sudo sysctl -w net.ipv4.ip_forward=0 >/dev/null 2>&1 || true

  if sudo systemctl enable --now "wg-quick@wg0" 2>/dev/null; then
    sudo wg show >/dev/null 2>&1 && ok "wg0 已啟動" || warn "wg show 無輸出"
  else
    warn "wg-quick@wg0 啟動失敗（WSL 常見：核心模組未載入）。正式機必須成功。"
  fi
else
  step "步驟 7：WireGuard —— 跳過（SF_SETUP_WIREGUARD=0）"
fi

# ══════════════════════════════════════════════════════════════
if [ "$SF_SETUP_FIREWALL" = "1" ]; then
  step "步驟 8：防火牆 —— 只開 UDP ${SF_WG_PORT}"
  # ⚠️ firewalld 在 AlmaLinux 10 預設未安裝（2026-08-14 實測）
  sudo dnf -y install firewalld
  sudo systemctl enable --now firewalld
  sudo firewall-cmd --permanent --add-port="${SF_WG_PORT}/udp"
  # ⚠️ 放行 loopback，否則服務連不上自己的資料庫（理由見檔案上方 ensure_loopback_trusted）
  ensure_loopback_trusted
  # ⭐ 第二道防線：把 wg0 劃進 trusted zone，只有它能碰 API 埠。
  #    綁「介面」而不是 IP 範圍是刻意的——介面是實打實的隧道出口，
  #    偽造來源位址繞不過。這樣就算日後有人把 HOST 改成 0.0.0.0，
  #    防火牆仍然擋著，不會像單靠 HOST 那樣「改錯了完全沒有徵兆」。
  #    ⚠️ 不用 SELinux 之後，這一層更重要——它已經是最後一道了。
  sudo firewall-cmd --permanent --zone=trusted --add-interface=wg0 2>/dev/null || true
  sudo firewall-cmd --permanent --zone=trusted --add-port="${SF_PORT}/tcp" 2>/dev/null || true
  sudo firewall-cmd --reload
  ok "防火牆：UDP ${SF_WG_PORT} 對外；TCP ${SF_PORT} 僅限 wg0"
  warn "⚠️ 不要開 80/443/3306/6379 —— 開了就抵銷這個架構的稽核價值"
else
  step "步驟 8：防火牆 —— 跳過（SF_SETUP_FIREWALL=0）"
fi

# ══════════════════════════════════════════════════════════════
step "步驟 9：服務帳號目錄與環境檔"
sudo install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/server-foundation/storage
sudo install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/backups/server-foundation
sudo install -d -m 0755 -o root -g root /opt/server-foundation/releases
ok "目錄"

# ⚠️ 陷阱 A（見檔頭）：storage 是 0700 且屬 server-foundation。
#    任何用 root 在裡面建檔的動作，都會讓服務讀不到自己的檔案。
sudo chown -R "$SERVICE_USER:$SERVICE_USER" /var/lib/server-foundation /var/backups/server-foundation
ok "storage/backup 擁有者已收斂為 ${SERVICE_USER}"

# ⚠️ 同上：一定要 sudo test -f，`[ -f ]` 在 0750 的目錄底下一律回假，
#    會導致每次重跑都用範本蓋掉既有 env（含已填好的簽章密鑰）。
if ! sudo test -f "$ENV_FILE"; then
  sudo install -m 0600 -o root -g "$SERVICE_USER" \
    "$REPO_DIR/deploy/env/server-foundation.env.example" "$ENV_FILE"
  ok "已從範本建立 ${ENV_FILE}"
else
  ok "${ENV_FILE} 已存在（不覆蓋）"
fi
# ⚠️ 範本是照「有反向代理」寫的，本架構要改四個值：
#   HOST                 → 綁隧道介面，絕不可 0.0.0.0（範本是 127.0.0.1）
#   PORT                 → 避開被佔用的 8787
#   TRUST_PROXY_HEADERS  → 沒有代理卻信任 X-Forwarded-For，來源 IP 可偽造、登入限流形同虛設
#   MYSQL_URL            → 範本是 CHANGE_ME
# ⚠️ MYSQL_URL 用 | 當 sed 分隔符會炸（URL 含 /），這裡用 # 且密碼字元集已限制成 [A-Za-z0-9]。
sudo sed -i \
  -e "s|^HOST=.*|HOST=${SF_HOST}|" \
  -e "s|^PORT=.*|PORT=${SF_PORT}|" \
  -e "s|^TRUST_PROXY_HEADERS=.*|TRUST_PROXY_HEADERS=false|" \
  -e "s#^MYSQL_URL=.*#MYSQL_URL=${MYSQL_URL_VALUE}#" \
  "$ENV_FILE"
sudo chmod 0600 "$ENV_FILE"
sudo chown root:"$SERVICE_USER" "$ENV_FILE"
ok "${ENV_FILE}：HOST=${SF_HOST} PORT=${SF_PORT} TRUST_PROXY_HEADERS=false MYSQL_URL=已填"

# ⚠️ 獨立驗證：CHANGE_ME 全部換掉了沒？留一個服務就起不來。
if sudo grep -q 'CHANGE_ME' "$ENV_FILE"; then
  warn "${ENV_FILE} 仍有 CHANGE_ME 的欄位："
  sudo grep -n 'CHANGE_ME' "$ENV_FILE" | sed 's/^/      /'
  warn "⚠️ 這些是這支腳本不該替你決定的值（例如簽章密鑰）。請自行填後再繼續。"
fi

sudo install -m 0644 "$REPO_DIR/deploy/systemd/server-foundation.service" \
  /etc/systemd/system/server-foundation.service
sudo systemctl daemon-reload
ok "systemd unit 已安裝"

if [ "$SF_STOP_AFTER" = "system" ]; then
  step "SF_STOP_AFTER=system ⇒ 到此為止"
  echo "  接著要跑：SF_STOP_AFTER=all bash deploy/scripts/bootstrap-almalinux10.sh"
  exit 0
fi

# ══════════════════════════════════════════════════════════════
step "步驟 10：建置並打包 release"
cd "$REPO_DIR"
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm release:package
# ⚠️ 不要用 `ls | head` 猜檔名——版本號從 package.json 讀，拿到的是實值。
RELEASE_VERSION_VALUE="${RELEASE_VERSION:-v$(node -p "require('$REPO_DIR/package.json').version")}"
ARCHIVE="$REPO_DIR/release/server-foundation-${RELEASE_VERSION_VALUE}.tar.gz"
[ -f "$ARCHIVE" ] || die "打包產物不存在：$ARCHIVE"
ok "release: $(basename "$ARCHIVE")"

# ══════════════════════════════════════════════════════════════
step "步驟 11：安裝 release（含 migration）"

# ⚠️ install-release.sh 遇到「同版本目錄已存在」會直接拒絕：
#      release already exists: /opt/server-foundation/releases/vX
#    而它在 migration 失敗時**不會清掉自己剛建的目錄** ⇒ 下一次重跑必定卡在這裡。
#    2026-08-15 實測撞到（前一輪死在 tsc 缺失，留下半成品目錄）。
RELEASE_TARGET="/opt/server-foundation/releases/${RELEASE_VERSION_VALUE}"
if sudo test -d "$RELEASE_TARGET"; then
  CURRENT_LINK_TARGET="$(sudo readlink -f /opt/server-foundation/current 2>/dev/null || true)"
  if [ "$CURRENT_LINK_TARGET" = "$RELEASE_TARGET" ] \
     && systemctl is-active --quiet server-foundation 2>/dev/null \
     && curl -fsS "http://${SF_HOST}:${SF_PORT}/health/ready" >/dev/null 2>&1; then
    ok "${RELEASE_VERSION_VALUE} 已是現行版本且服務健康 ⇒ 跳過安裝"
    SKIP_INSTALL=1
  else
    # ⚠️ 只在「它不是現行版本」時才刪。現行版本底下有正在服務的程式，刪了會當場斷線。
    #    路徑護欄：兩個變數都不可為空，且必須落在 releases/ 底下。
    [ -n "$RELEASE_VERSION_VALUE" ] || die "RELEASE_VERSION_VALUE 為空，拒絕刪除"
    case "$RELEASE_TARGET" in
      /opt/server-foundation/releases/?*) : ;;
      *) die "拒絕刪除非預期路徑：$RELEASE_TARGET" ;;
    esac
    warn "偵測到上一輪失敗留下的 ${RELEASE_VERSION_VALUE}（非現行版本）⇒ 清掉重裝"
    sudo rm -rf "$RELEASE_TARGET"
    SKIP_INSTALL=0
  fi
else
  SKIP_INSTALL=0
fi

if [ "$SKIP_INSTALL" = "0" ]; then
# ⚠️ install-release.sh 的健康檢查網址預設寫死 http://127.0.0.1:8787/health/ready。
#    PORT 改過卻不覆寫，它會探測失敗並【自動 rollback】——
#    而且 rollback 是「成功」的行為，退出碼看起來很正常。
# ⚠️ 一律用 `bash <路徑>` 叫，不靠執行位。
#    2026-08-15 實測：install-release.sh 在 git 裡是 100644（已一併修成 100755），
#    而 sudo 對不可執行的檔案回報的是 **"command not found"** ——訊息完全指錯方向。
#    tarball 解開、檔案系統掛 noexec 等情況也會重現，走 bash 就都免疫。
  sudo SERVER_FOUNDATION_HEALTH_URL="http://${SF_HOST}:${SF_PORT}/health/ready" \
       bash "$REPO_DIR/deploy/scripts/install-release.sh" "$ARCHIVE" "$RELEASE_VERSION_VALUE"
  ok "install-release.sh 回報成功"
fi

# ══════════════════════════════════════════════════════════════
step "步驟 12：驗證（⚠️ 不看退出碼，看實際狀態）"

sudo systemctl is-active --quiet server-foundation \
  || die "server-foundation 未在執行：sudo journalctl -u server-foundation -n 50"
ok "服務 active"

# ⚠️ 這是唯一驗得出「靜默失效」的一步：HOST 填錯不會有任何錯誤訊息。
# ⚠️⚠️ 只能看**本地位址欄（第 4 欄）**，不可以 grep 整行。
#    `ss -ltnp` 的第 5 欄是對端位址，而所有 IPv4 listener 的對端欄位
#    都是字面的 `0.0.0.0:*`：
#        LISTEN 0 4096  127.0.0.1:33306   0.0.0.0:*
#                       ^^^^^^^^^^ 第4欄    ^^^^^^^^^ 第5欄，永遠長這樣
#    ⇒ 拿整行去 grep '0.0.0.0' 會**無條件命中**，這道檢查就永遠失敗。
#    2026-08-15 實測：服務其實好好地綁在 127.0.0.1，我卻據此判它暴露在網段上，
#    然後去追一個不存在的缺陷。**探針錯了比沒有探針更花時間。**
LISTEN_LOCAL="$(sudo ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' \
                 | grep -E "[:.]${SF_PORT}\$" || true)"
[ -n "$LISTEN_LOCAL" ] || die "沒有任何程式在聽 ${SF_PORT}"
if printf '%s\n' "$LISTEN_LOCAL" | grep -qE '^(0\.0\.0\.0|\*|\[?::\]?):'; then
  die "❌ 服務開在 0.0.0.0:${SF_PORT} —— 對整個院內網段暴露。檢查 ${ENV_FILE} 的 HOST。"
fi
ok "監聽位址正確：${LISTEN_LOCAL}"

curl -fsS "http://${SF_HOST}:${SF_PORT}/health/ready" >/dev/null \
  || die "/health/ready 不通"
ok "/health/ready 通"

# ══════════════════════════════════════════════════════════════
if [ -n "$SF_ADMIN_EMAIL" ]; then
  step "步驟 13：建立第一個帳號"
  # ⚠️ 沒有 tenants 表，tenant_id 只是無外鍵的 CHAR(36) ⇒ 任何 UUID 都可以，
  #    但同一個租戶的使用者必須共用同一個值，之後不好改，第一次就記下來。
  TENANT="${SF_TENANT_ID:-$(node -p 'require("node:crypto").randomUUID()')}"
  if MYSQL_URL="$MYSQL_URL_VALUE" node "$REPO_DIR/scripts/create-user.mjs" \
        --email "$SF_ADMIN_EMAIL" --tenant "$TENANT" --roles "$SF_ADMIN_ROLES"; then
    echo
    warn "⚠️ 上面那行 Generated password 只出現這一次，現在就存進密碼管理器。"
    warn "⚠️ tenant id：${TENANT} —— 之後加人要用同一個，記下來。"
  else
    warn "建帳號失敗（若訊息是 already exists，代表重跑，可忽略）"
  fi
else
  step "步驟 13：建立第一個帳號 —— 跳過"
  echo "  要建就設 SF_ADMIN_EMAIL：
    MYSQL_URL=\"\$(sudo grep ^MYSQL_URL= ${ENV_FILE} | cut -d= -f2-)\" \\
      node ${REPO_DIR}/scripts/create-user.mjs \\
        --email you@example.com --tenant \$(uuidgen) --roles developer"
fi

# ══════════════════════════════════════════════════════════════
step "完成"
echo
echo "  API      http://${SF_HOST}:${SF_PORT}"
echo "  版本     ${RELEASE_VERSION_VALUE}"
echo
echo "  之後每次上新版只要："
echo "    sudo SERVER_FOUNDATION_HEALTH_URL=http://${SF_HOST}:${SF_PORT}/health/ready \\"
echo "         deploy/scripts/install-release.sh <新的.tar.gz> <版本>"
echo
echo "  正式機還要自己做的（這台驗不到）："
echo "    ① 把 HOST 改成 wg0 的位址（現在是 ${SF_HOST}）並重啟服務"
echo "    ② 每台桌面電腦一段 [Peer]，AllowedIPs 必須 /32"
echo "    ③ sudo firewall-cmd --list-ports 應只有 ${SF_WG_PORT}/udp"
echo
ok "全部完成"
