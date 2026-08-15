#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB_DIR=/usr/local/libexec/server-foundation-backup
R2_ENV_FILE=/etc/server-foundation/offsite-backup.env
BACKUP_BIN=/usr/local/sbin/server-foundation-offsite-backup
RESTORE_BIN=/usr/local/sbin/server-foundation-offsite-restore
REHEARSE_BIN=/usr/local/sbin/server-foundation-offsite-rehearse
SERVICE=server-foundation-offsite-backup.service
TIMER=server-foundation-offsite-backup.timer

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m  %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

sudo -v || die "需要 sudo 權限"
[ -f "$REPO_DIR/scripts/backup.mjs" ] || die "找不到 repo 根目錄：$REPO_DIR"
sudo test -f /etc/server-foundation/server-foundation.env \
  || die "請先完成 bootstrap；缺少 /etc/server-foundation/server-foundation.env"

sudo install -d -m 0755 -o root -g root "$LIB_DIR"
for file in \
  backup-common.mjs \
  backup.mjs \
  restore.mjs \
  offsite-r2.mjs \
  offsite-backup.mjs \
  offsite-restore.mjs \
  offsite-backup-restore-rehearsal.mjs; do
  sudo install -m 0755 -o root -g root "$REPO_DIR/scripts/$file" "$LIB_DIR/$file"
done
sudo ln -sfn "$LIB_DIR/offsite-backup.mjs" "$BACKUP_BIN"
sudo ln -sfn "$LIB_DIR/offsite-restore.mjs" "$RESTORE_BIN"
sudo ln -sfn "$LIB_DIR/offsite-backup-restore-rehearsal.mjs" "$REHEARSE_BIN"
ok "管理工具已安裝到 $LIB_DIR，入口位於 /usr/local/sbin"

sudo install -d -m 0750 -o root -g server-foundation /etc/server-foundation
# 與 #20 同一個坑：0750 目錄底下一般使用者不能用 [ -f ] 正確判斷。
# 一定用 sudo test -f；重跑只修權限，不覆蓋已填好的 R2 credentials。
if ! sudo test -f "$R2_ENV_FILE"; then
  sudo install -m 0600 -o root -g root \
    "$REPO_DIR/deploy/offsite-backup.env.example" "$R2_ENV_FILE"
  ok "已建立 $R2_ENV_FILE（0600 root:root；先填 CHANGE_ME）"
else
  ok "$R2_ENV_FILE 已存在（保留既有 credentials）"
fi
sudo chmod 0600 "$R2_ENV_FILE"
sudo chown root:root "$R2_ENV_FILE"
MODE="$(sudo stat -c '%a %U %G' "$R2_ENV_FILE")"
[ "$MODE" = "600 root root" ] \
  || die "$R2_ENV_FILE 權限不安全（實際：$MODE；預期：600 root root）"

sudo install -m 0644 -o root -g root \
  "$REPO_DIR/deploy/systemd/$SERVICE" "/etc/systemd/system/$SERVICE"
sudo install -m 0644 -o root -g root \
  "$REPO_DIR/deploy/systemd/$TIMER" "/etc/systemd/system/$TIMER"
sudo systemctl daemon-reload

if sudo grep -q '=CHANGE_ME$' "$R2_ENV_FILE"; then
  sudo systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
  warn "$R2_ENV_FILE 還有 CHANGE_ME；timer 已安裝但刻意不啟用。"
  warn "建立專用 R2 bucket/API token 後：sudoedit $R2_ENV_FILE"
  warn "填完先跑：sudo $BACKUP_BIN --dry-run"
  warn "確認後啟用：sudo systemctl enable --now $TIMER"
else
  sudo systemctl enable --now "$TIMER"
  ok "$TIMER 已啟用；每天約 03:30（另加最多 30 分鐘隨機延遲）執行"
fi

cat <<EOF2

手動檢查 retention（只列遠端，不建立／上傳／刪除任何東西）：
  sudo $BACKUP_BIN --dry-run

手動立即備份並套用 retention：
  sudo $BACKUP_BIN

災難還原最新一份（會覆寫資料，必須顯式確認）：
  sudo RESTORE_CONFIRM=YES $RESTORE_BIN --latest

真機異地還原演練（會先刪掉本機演練 backup，強迫從 R2 取回）：
  sudo OFFSITE_REHEARSAL_CONFIRM=YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE $REHEARSE_BIN
EOF2
