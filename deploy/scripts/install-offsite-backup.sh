#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB_DIR=/usr/local/libexec/server-foundation-backup
UPLOAD_ENV_FILE=/etc/server-foundation/offsite-backup.env
RESTORE_EXAMPLE=/usr/local/share/server-foundation/offsite-restore.env.example
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

# Security migration: the old #22 file stored R2 Object Read & Write credentials.
# Never overwrite those values automatically. Stop the timer first so the old
# delete-capable credential cannot keep running while the operator migrates it.
if sudo test -f "$UPLOAD_ENV_FILE" \
  && sudo grep -Eq '^(R2_ACCOUNT_ID|R2_BUCKET|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY)=' "$UPLOAD_ENV_FILE"; then
  sudo systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
  warn "$UPLOAD_ENV_FILE 仍含舊版 R2 Object Read & Write credential；timer 已停用。"
  warn "installer 不覆蓋既有值。請先在 Cloudflare 建 upload-only Worker、撤銷舊 write token，"
  warn "再手動把此檔改成 OFFSITE_UPLOAD_URL / OFFSITE_UPLOAD_TOKEN / R2_PREFIX 後重跑。"
  die "拒絕在院內主機保留可直接刪 R2 object 的 credential"
fi

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
if ! sudo test -f "$UPLOAD_ENV_FILE"; then
  sudo install -m 0600 -o root -g root \
    "$REPO_DIR/deploy/offsite-backup.env.example" "$UPLOAD_ENV_FILE"
  ok "已建立 $UPLOAD_ENV_FILE（0600 root:root；先填 CHANGE_ME）"
else
  ok "$UPLOAD_ENV_FILE 已存在（保留既有 upload credential，不覆蓋）"
fi
sudo chmod 0600 "$UPLOAD_ENV_FILE"
sudo chown root:root "$UPLOAD_ENV_FILE"
MODE="$(sudo stat -c '%a %U %G' "$UPLOAD_ENV_FILE")"
[ "$MODE" = "600 root root" ] \
  || die "$UPLOAD_ENV_FILE 權限不安全（實際：$MODE；預期：600 root root）"

sudo install -d -m 0755 -o root -g root /usr/local/share/server-foundation
sudo install -m 0644 -o root -g root \
  "$REPO_DIR/deploy/offsite-restore.env.example" "$RESTORE_EXAMPLE"
ok "read-only restore credential 範本：$RESTORE_EXAMPLE（真 credential 不應常駐主機）"

sudo install -m 0644 -o root -g root \
  "$REPO_DIR/deploy/systemd/$SERVICE" "/etc/systemd/system/$SERVICE"
sudo install -m 0644 -o root -g root \
  "$REPO_DIR/deploy/systemd/$TIMER" "/etc/systemd/system/$TIMER"
sudo systemctl daemon-reload

if sudo grep -q '=CHANGE_ME$' "$UPLOAD_ENV_FILE"; then
  sudo systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
  warn "$UPLOAD_ENV_FILE 還有 CHANGE_ME；timer 已安裝但刻意不啟用。"
  warn "部署 Cloudflare upload-only Worker 後：sudoedit $UPLOAD_ENV_FILE"
  warn "填完先跑：sudo $BACKUP_BIN --dry-run"
  warn "確認後重跑本 installer，或手動 enable --now $TIMER"
else
  sudo "$BACKUP_BIN" --dry-run
  sudo systemctl enable --now "$TIMER"
  ok "$TIMER 已啟用；每天約 03:30（另加最多 30 分鐘隨機延遲）執行"
fi

cat <<EOF2

手動驗 upload endpoint/auth（不建立、不上傳、不 list/read/delete R2）：
  sudo $BACKUP_BIN --dry-run

手動立即備份（retention 由 R2 Object Lifecycle 執行）：
  sudo $BACKUP_BIN

災難還原前，從離線/密碼庫把 Object Read only credential 暫放到：
  /run/server-foundation/offsite-restore.env
然後：
  sudo RESTORE_CONFIRM=YES $RESTORE_BIN --latest
完成後：
  sudo rm -f /run/server-foundation/offsite-restore.env

真機異地還原演練同樣需要暫時的 read-only restore credential：
  sudo OFFSITE_REHEARSAL_CONFIRM=YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE $REHEARSE_BIN
EOF2
