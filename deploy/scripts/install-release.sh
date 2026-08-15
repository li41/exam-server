#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <release.tar.gz> <release-id>" >&2
  exit 2
fi

archive="$(realpath "$1")"
release_id="$2"
release_root="${SERVER_FOUNDATION_RELEASE_ROOT:-/opt/server-foundation/releases}"
current_link="${SERVER_FOUNDATION_CURRENT_LINK:-/opt/server-foundation/current}"
env_file="${SERVER_FOUNDATION_ENV_FILE:-/etc/server-foundation/server-foundation.env}"
service="${SERVER_FOUNDATION_SERVICE:-server-foundation}"
health_url="${SERVER_FOUNDATION_HEALTH_URL:-http://127.0.0.1:8787/health/ready}"
target="$release_root/$release_id"

if [ ! -f "$archive" ]; then
  echo "release archive not found: $archive" >&2
  exit 1
fi
if [ -e "$target" ]; then
  echo "release already exists: $target" >&2
  exit 1
fi
if [ ! -r "$env_file" ]; then
  echo "environment file is not readable: $env_file" >&2
  exit 1
fi

if [ -f "$archive.sha256" ]; then
  (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256")
fi

mysql_url="$(sed -n 's/^MYSQL_URL=//p' "$env_file" | head -n 1)"
if [ -z "$mysql_url" ]; then
  echo "MYSQL_URL is missing from $env_file" >&2
  exit 1
fi

mkdir -p "$release_root" "$(dirname "$current_link")"
mkdir "$target"
tar -xzf "$archive" -C "$target"

corepack pnpm --dir "$target" install --prod --frozen-lockfile

# ⚠️⚠️ 這一段一定要在 `pnpm install` **之後**，不能在前面。
#
# 兩個來源都會讓服務帳號讀不到自己的程式，而且都不是部署端能控制的：
#   ① tar 保留的是**打包機器的 umask**。打包時 umask 077 ⇒ 解開後 0600。
#   ② pnpm 從**全域 store 硬連結**檔案進來（ls 看到 link count 2）。
#      store 裡的檔案若曾在 umask 077 下建立，之後每一次安裝都會複製那個模式，
#      **就算現在的 umask 已經修好也一樣**。
#   ⇒ ② 發生在 pnpm install 期間 ⇒ 放在前面的 chmod 蓋不到它。
#
# ⚠️ Node 對「讀不到」報的是 MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND，
#    看起來像檔案沒被打包進去，實際上檔案就在那裡、只是沒權限。
#    2026-08-15 實測被這個訊息帶偏兩次。
#
# 機密在 /etc/server-foundation 的 env 檔（0600），不在這棵樹裡。
chown -R root:root "$target"
chmod -R u=rwX,go=rX "$target"
MYSQL_URL="$mysql_url" corepack pnpm --dir "$target" --filter @server-foundation/mysql-adapter migrate

# ⚠️ 一定要先確認 current 真的是一條既存的 symlink 才取它的目標。
#    原本直接 `readlink -f "$current_link"`：當 current **還不存在**時，
#    readlink -f 會回傳**那條路徑本身**，於是 previous=/opt/server-foundation/current。
#    等下面 mv 建好 symlink 之後，`[ -d "$previous" ]` 就變成真，
#    回滾時 `ln -s "$previous"` 產生 **current -> current 的自環**，
#    服務從此起不來（CHDIR: Too many levels of symbolic links），而且重跑也修不回來。
#    2026-08-15 首次安裝失敗時實際發生過。
if [ -L "$current_link" ]; then
  previous="$(readlink -f "$current_link" 2>/dev/null || true)"
else
  previous=""
fi
next_link="${current_link}.next"
rm -f "$next_link"
ln -s "$target" "$next_link"
mv -Tf "$next_link" "$current_link"
systemctl restart "$service"

healthy=false
for _ in {1..30}; do
  if curl -fsS "$health_url" >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done

if [ "$healthy" = true ]; then
  # A release is not considered fully deployed until the service will also
  # return after a host reboot. `enable` is idempotent, so every successful
  # release also repairs older hosts that were active but never enabled.
  if ! systemctl enable "$service"; then
    echo "release $release_id is healthy but failed to enable $service for boot" >&2
    exit 1
  fi
  if ! systemctl is-enabled --quiet "$service"; then
    echo "release $release_id is healthy but $service is not enabled for boot" >&2
    exit 1
  fi
  echo "release $release_id is healthy, active, and enabled for boot"
  exit 0
fi

echo "release $release_id failed readiness check" >&2
# ⚠️ 第二道保險：previous 絕不可等於 current_link 本身（否則就是自環）。
if [ -n "$previous" ] && [ "$previous" != "$current_link" ] && [ -d "$previous" ]; then
  rm -f "$next_link"
  ln -s "$previous" "$next_link"
  mv -Tf "$next_link" "$current_link"
  systemctl restart "$service"
  echo "rolled back current symlink to $previous" >&2
fi
exit 1
