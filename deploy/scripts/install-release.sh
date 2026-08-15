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

# tar 保留打包當時的擁有者與權限，而那取決於**打包機器的 umask**，不是這裡能控制的。
# 若打包時 umask 是 077，解開後會是 0600 且屬打包者 ⇒ 服務帳號讀不到自己的程式。
# ⚠️ Node 對「讀不到」報的是 MODULE_NOT_FOUND，看起來像檔案不存在，
#    實際上檔案就在那裡、只是沒權限——2026-08-15 實測被這個訊息帶偏過。
# ⇒ 一律正規化：release 樹 root 擁有、其他人唯讀（機密在 /etc 的 env 檔，不在這裡）。
chown -R root:root "$target"
chmod -R u=rwX,go=rX "$target"

corepack pnpm --dir "$target" install --prod --frozen-lockfile
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
  echo "release $release_id is healthy and active"
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
