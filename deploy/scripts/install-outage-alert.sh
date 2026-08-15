#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALERT_ENV_FILE=/etc/server-foundation/outage-alert.env
HEARTBEAT_BIN=/usr/local/sbin/server-foundation-outage-heartbeat
SERVICE=server-foundation-outage-heartbeat.service
TIMER=server-foundation-outage-heartbeat.timer

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m  %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

sudo -v || die "需要 sudo 權限"
[ -f "$REPO_DIR/scripts/outage-heartbeat.mjs" ] \
  || die "找不到 repo 根目錄：$REPO_DIR"
sudo test -f /etc/server-foundation/server-foundation.env \
  || die "請先完成主 bootstrap；缺少 /etc/server-foundation/server-foundation.env"

sudo install -d -m 0750 -o root -g server-foundation /etc/server-foundation
sudo install -m 0755 -o root -g root \
  "$REPO_DIR/scripts/outage-heartbeat.mjs" "$HEARTBEAT_BIN"
ok "heartbeat 工具已安裝：$HEARTBEAT_BIN"

# 0750 目錄底下一般使用者不能用 [ -f ] 可靠判斷；一定用 sudo test -f。
# 重跑只修權限，不覆蓋已填好的 Ping URL。
if ! sudo test -f "$ALERT_ENV_FILE"; then
  sudo install -m 0600 -o root -g root \
    "$REPO_DIR/deploy/outage-alert.env.example" "$ALERT_ENV_FILE"
  ok "已建立 $ALERT_ENV_FILE（0600 root:root；先填 CHANGE_ME）"
else
  ok "$ALERT_ENV_FILE 已存在（保留既有設定）"
fi
sudo chmod 0600 "$ALERT_ENV_FILE"
sudo chown root:root "$ALERT_ENV_FILE"
MODE="$(sudo stat -c '%a %U %G' "$ALERT_ENV_FILE")"
[ "$MODE" = "600 root root" ] \
  || die "$ALERT_ENV_FILE 權限不安全（實際：$MODE；預期：600 root root）"

sudo install -m 0644 -o root -g root \
  "$REPO_DIR/deploy/systemd/$SERVICE" "/etc/systemd/system/$SERVICE"
sudo install -m 0644 -o root -g root \
  "$REPO_DIR/deploy/systemd/$TIMER" "/etc/systemd/system/$TIMER"
sudo systemctl daemon-reload

if sudo grep -q '^HEALTHCHECKS_PING_URL=CHANGE_ME$' "$ALERT_ENV_FILE"; then
  sudo systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
  warn "$ALERT_ENV_FILE 還有 CHANGE_ME；timer 已安裝但刻意不啟用。"
  warn "請先建立外部 check 與通知 integrations，再編輯：sudoedit $ALERT_ENV_FILE"
  warn "填完後重跑本 installer。"
  exit 0
fi

sudo systemctl enable --now "$TIMER"
if ! sudo systemctl start "$SERVICE"; then
  warn "第一次 heartbeat 失敗；timer 保持啟用，外部 dead-man check 仍可偵測漏報。"
  die "請查：sudo journalctl -u $SERVICE -n 50 --no-pager"
fi
ok "$TIMER 已啟用；每 5 分鐘送一次 heartbeat"

cat <<EOF2

確認 timer 與最近一次 heartbeat：
  sudo systemctl status $TIMER --no-pager
  sudo journalctl -u $SERVICE -n 20 --no-pager

明確送一個測試 outage，確認外部通知真的會叫：
  sudo $HEARTBEAT_BIN --test-alert

測試後送正常 heartbeat 回復 Up（/health/ready 必須三格全綠）：
  sudo $HEARTBEAT_BIN
EOF2
