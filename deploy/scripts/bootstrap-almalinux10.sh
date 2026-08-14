#!/usr/bin/env bash
#
# AlmaLinux 10 全新機器 → 可以跑 install-release.sh 的狀態
#
# 用法：
#   bash deploy/scripts/bootstrap-almalinux10.sh
#   SF_PORT=18787 SF_WG_ADDR=10.99.0.1 bash deploy/scripts/bootstrap-almalinux10.sh
#
# ⚠️ 這支不含 root 密碼，一律走互動式 sudo。不要把密碼寫進這個檔或任何檔案。
# ⚠️ 可重複執行（idempotent）。每一步做完就驗，驗不過就停。
#
# 對照文件：doc/almalinux-10-安裝.md
# ⚠️ 三處與該文件不符，是 2026-08-14 在 AlmaLinux 10.2 實測後修正的：
#   1. el10 沒有 dnf modularity ⇒ `dnf module list nodejs` 直接報錯，只能走 NodeSource
#   2. 套件叫 `mysql8.4-server`（不是 `mysql-server`）
#   3. RHEL 10 移除 Redis ⇒ 改用 `valkey`（Redis 相容分支）
#
# ──────────────────────────────────────────────────────────────
# 關於「PHP 那種更新後 session 權限就變」的問題（主公 2026-08-14 問）
#
#   本系統的 session 存在 Redis/Valkey，**不是檔案** ⇒ 沒有 PHP 那個問題。
#
#   但這個技術棧有三個「同一類」的陷阱，這支腳本都處理了：
#     A. /var/lib/server-foundation/storage 是 0700 且屬 server-foundation。
#        若有任何步驟用 root 在裡面建檔，服務就讀不到自己的檔案。
#     B. SELinux 標籤：AlmaLinux 上真正會「更新後突然沒權限」的是它，不是檔案模式。
#        套件更新或有人跑 restorecon 之後，標籤可能被重設。
#     C. systemd unit 寫死 /usr/bin/node ⇒ Node 換裝方式（例如 nvm）就起不來，
#        而錯誤訊息只說找不到檔案。
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# ── 可調參數 ───────────────────────────────────────────────────
SF_PORT="${SF_PORT:-18787}"          # ⚠️ 預設刻意不是 8787，理由見下方 check_port_free
SF_HOST="${SF_HOST:-127.0.0.1}"      # ⚠️ 正式機要改成 WireGuard 介面位址，絕不可填 0.0.0.0
SF_WG_ADDR="${SF_WG_ADDR:-10.99.0.1}"
SF_WG_CIDR="${SF_WG_CIDR:-10.99.0.1/24}"
SF_WG_PORT="${SF_WG_PORT:-51820}"
SF_DB_NAME="${SF_DB_NAME:-server_foundation}"
SF_DB_USER="${SF_DB_USER:-server_foundation}"
SF_SETUP_WIREGUARD="${SF_SETUP_WIREGUARD:-1}"
SF_SETUP_FIREWALL="${SF_SETUP_FIREWALL:-1}"
SF_INSTALL_PNPM="${SF_INSTALL_PNPM:-0}"   # 只有要在這台建置才需要

ENV_FILE=/etc/server-foundation/server-foundation.env
SERVICE_USER=server-foundation

# ── 輸出 ──────────────────────────────────────────────────────
step() { printf '\n\033[1;36m━━ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

# ⚠️ 這支腳本會多次 sudo。先要一次，之後才不會在中途卡住等密碼。
sudo -v || die "需要 sudo 權限"

if is_wsl; then
  warn "偵測到 WSL。以下三項在這裡驗不到，正式機必須重跑一次："
  warn "  ① SELinux（此映像未安裝 selinux-policy）"
  warn "  ② 防火牆作為真實邊界"
  warn "  ③ 「院內網段掃不到任何 TCP 服務」這個稽核性質"
fi

# ══════════════════════════════════════════════════════════════
step "步驟 0：埠號預檢（⚠️ 這一步擋掉最惡劣的失敗形狀）"
# 8787 在主公 這台被逸策台 daemon 佔著，而 **那支的 /health 也回 200**。
# 若沿用 8787，健康檢查會拿到 200 而你以為 exam-server 起來了——
# 實際上在跟一個完全無關的程式講話。這是「看起來成功」的失敗，最難發現。
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${SF_PORT}\$"; then
  die "埠 ${SF_PORT} 已被佔用。換一個：SF_PORT=<其他> 重跑。"
fi
ok "埠 ${SF_PORT} 空著"

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
if [ "$SF_INSTALL_PNPM" = "1" ]; then
  step "步驟 3：pnpm（要在這台建置才需要）"
  sudo corepack enable 2>/dev/null || sudo npm i -g corepack
  corepack prepare pnpm@11.10.0 --activate
  ok "pnpm $(pnpm -v 2>/dev/null || echo '?')"
else
  step "步驟 3：pnpm —— 跳過（SF_INSTALL_PNPM=1 才裝）"
  ok "改為在別處打包，用 install-release.sh 安裝 tarball"
fi

# ══════════════════════════════════════════════════════════════
step "步驟 4：MySQL 8.4"
# ⚠️ 套件名是 mysql8.4-server，不是 mysql-server（後者在 el10 不存在）
if ! rpm -q mysql8.4-server >/dev/null 2>&1; then
  sudo dnf -y install mysql8.4-server
fi
sudo systemctl enable --now mysqld
sudo systemctl is-active --quiet mysqld || die "mysqld 未啟動"
ok "MySQL $(mysql --version 2>/dev/null | grep -oE '8\.[0-9.]+' | head -1)"

warn "資料庫與帳號請自行建立（腳本不碰密碼）："
cat <<EOSQL
    sudo mysql -e "CREATE DATABASE IF NOT EXISTS \`${SF_DB_NAME}\` CHARACTER SET utf8mb4;"
    sudo mysql -e "CREATE USER IF NOT EXISTS '${SF_DB_USER}'@'127.0.0.1' IDENTIFIED BY '<你的密碼>';"
    sudo mysql -e "GRANT ALL ON \`${SF_DB_NAME}\`.* TO '${SF_DB_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;"
EOSQL
# ⚠️ MySQL 的 'user'@'localhost' 與 'user'@'127.0.0.1' 是兩個不同帳號。
#    連線字串寫 127.0.0.1 就必須建 @'127.0.0.1' 那個，建錯會得到 access denied。

# ══════════════════════════════════════════════════════════════
step "步驟 5：Valkey（RHEL 10 的 Redis 替代）"
# ⚠️ RHEL/AlmaLinux 10 已移除 redis 套件，改提供 valkey（Redis 相容分支）。
#    ⚠️ 未確認：本專案的 redis adapter 對 Valkey 8 的相容性尚未實測。
#       若日後出現協定層問題，替代方案是從 Remi/EPEL 裝原生 Redis。
if ! rpm -q valkey >/dev/null 2>&1; then
  sudo dnf -y install valkey
fi
sudo systemctl enable --now valkey
sudo systemctl is-active --quiet valkey || die "valkey 未啟動"
redis-cli ping 2>/dev/null | grep -q PONG || valkey-cli ping | grep -q PONG || die "valkey 無回應"
ok "Valkey 已啟動並回 PONG"

# ══════════════════════════════════════════════════════════════
if [ "$SF_SETUP_WIREGUARD" = "1" ]; then
  step "步驟 6：WireGuard（伺服器端）"
  sudo dnf -y install wireguard-tools
  if [ ! -f /etc/wireguard/server.key ]; then
    sudo install -d -m 0700 /etc/wireguard
    umask 077
    wg genkey | sudo tee /etc/wireguard/server.key >/dev/null
    sudo chmod 0600 /etc/wireguard/server.key
    sudo sh -c 'wg pubkey < /etc/wireguard/server.key > /etc/wireguard/server.pub'
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
  step "步驟 6：WireGuard —— 跳過（SF_SETUP_WIREGUARD=0）"
fi

# ══════════════════════════════════════════════════════════════
if [ "$SF_SETUP_FIREWALL" = "1" ]; then
  step "步驟 7：防火牆 —— 只開 UDP ${SF_WG_PORT}"
  # ⚠️ firewalld 在 AlmaLinux 10 預設未安裝（2026-08-14 實測）
  sudo dnf -y install firewalld
  sudo systemctl enable --now firewalld
  sudo firewall-cmd --permanent --add-port="${SF_WG_PORT}/udp"
  # ⭐ 第二道防線：把 wg0 劃進 trusted zone，只有它能碰 API 埠。
  #    綁「介面」而不是 IP 範圍是刻意的——介面是實打實的隧道出口，
  #    偽造來源位址繞不過。這樣就算日後有人把 HOST 改成 0.0.0.0，
  #    防火牆仍然擋著，不會像單靠 HOST 那樣「改錯了完全沒有徵兆」。
  sudo firewall-cmd --permanent --zone=trusted --add-interface=wg0 2>/dev/null || true
  sudo firewall-cmd --permanent --zone=trusted --add-port="${SF_PORT}/tcp" 2>/dev/null || true
  sudo firewall-cmd --reload
  ok "防火牆：UDP ${SF_WG_PORT} 對外；TCP ${SF_PORT} 僅限 wg0"
  warn "⚠️ 不要開 80/443/3306/6379 —— 開了就抵銷這個架構的稽核價值"
else
  step "步驟 7：防火牆 —— 跳過（SF_SETUP_FIREWALL=0）"
fi

# ══════════════════════════════════════════════════════════════
step "步驟 8：SELinux"
if command -v getenforce >/dev/null 2>&1; then
  mode="$(getenforce)"
  ok "SELinux: ${mode}"
  [ "$mode" = "Enforcing" ] || warn "非 Enforcing。⚠️ 正式機不要用 setenforce 0 關掉，那是把問題藏起來。"
  warn "出事時先看它到底擋了什麼：sudo ausearch -m AVC -ts recent | audit2why"
else
  warn "此系統未安裝 SELinux（WSL 映像常見）"
  warn "⚠️ 正式機上 SELinux 是 Enforcing，本步驟必須在正式機重做一次。"
  warn "⚠️ 「更新後突然沒權限」在 AlmaLinux 上通常是 SELinux 標籤被重設，不是檔案模式。"
fi

# ══════════════════════════════════════════════════════════════
step "步驟 9：服務帳號、目錄、環境檔"
id -u "$SERVICE_USER" >/dev/null 2>&1 \
  || sudo useradd --system --home /var/lib/server-foundation --shell /sbin/nologin "$SERVICE_USER"
sudo install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/server-foundation/storage
sudo install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/backups/server-foundation
sudo install -d -m 0750 -o root -g "$SERVICE_USER" /etc/server-foundation
sudo install -d -m 0755 -o root -g root /opt/server-foundation/releases
ok "帳號與五個目錄"

# ⚠️ 陷阱 A（見檔頭）：storage 是 0700 且屬 server-foundation。
#    任何用 root 在裡面建檔的動作，都會讓服務讀不到自己的檔案。
#    這一步把整棵樹的擁有者收斂回去，可重複執行。
sudo chown -R "$SERVICE_USER:$SERVICE_USER" /var/lib/server-foundation /var/backups/server-foundation
ok "storage/backup 擁有者已收斂為 ${SERVICE_USER}"

if [ ! -f "$ENV_FILE" ]; then
  sudo install -m 0600 -o root -g "$SERVICE_USER" \
    deploy/env/server-foundation.env.example "$ENV_FILE"
  # ⚠️ 範本是照「有反向代理」寫的，本架構要改三個值：
  #   HOST                 → 綁隧道介面，絕不可 0.0.0.0（範本是 127.0.0.1）
  #   PORT                 → 避開被佔用的 8787
  #   TRUST_PROXY_HEADERS  → 沒有代理卻信任 X-Forwarded-For，來源 IP 可偽造、登入限流形同虛設
  sudo sed -i \
    -e "s|^HOST=.*|HOST=${SF_HOST}|" \
    -e "s|^PORT=.*|PORT=${SF_PORT}|" \
    -e "s|^TRUST_PROXY_HEADERS=.*|TRUST_PROXY_HEADERS=false|" \
    "$ENV_FILE"
  ok "已建立 ${ENV_FILE}（HOST=${SF_HOST} PORT=${SF_PORT} TRUST_PROXY_HEADERS=false）"
  warn "⚠️ MYSQL_URL 裡的 CHANGE_ME 還沒換 —— 服務會起不來，請先填。"
else
  ok "${ENV_FILE} 已存在（不覆蓋）"
fi

sudo install -m 0644 deploy/systemd/server-foundation.service \
  /etc/systemd/system/server-foundation.service
sudo systemctl daemon-reload
ok "systemd unit 已安裝"

# ══════════════════════════════════════════════════════════════
step "完成後的檢查清單"
echo
echo "  ⚠️ 這一項最重要，而且是唯一驗得出「靜默失效」的一步："
echo "     sudo ss -ltnp | grep -E '${SF_PORT}|3306|6379'"
echo "     ✅ 對：${SF_HOST}:${SF_PORT}   127.0.0.1:3306   127.0.0.1:6379"
echo "     ❌ 錯：0.0.0.0:${SF_PORT}  ← 服務仍開在區域網段上，且沒有任何錯誤訊息"
echo
echo "  其餘："
echo "     systemctl status wg-quick@wg0 server-foundation --no-pager"
echo "     sudo wg show                       # peer 數量與名冊相符"
echo "     sudo firewall-cmd --list-ports     # 應只有 ${SF_WG_PORT}/udp"
echo
step "下一步：安裝 release"
echo "  ⚠️ install-release.sh 的健康檢查網址寫死 http://127.0.0.1:8787/health/ready"
echo "     PORT 改過就一定要覆寫，否則它會探測失敗並【自動 rollback】："
echo
echo "     sudo SERVER_FOUNDATION_HEALTH_URL=http://${SF_HOST}:${SF_PORT}/health/ready \\"
echo "          deploy/scripts/install-release.sh ./server-foundation-vX.Y.Z.tar.gz vX.Y.Z"
echo
ok "bootstrap 完成"
