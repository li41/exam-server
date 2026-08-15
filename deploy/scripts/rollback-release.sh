#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <release-id>" >&2
  exit 2
fi

release_id="$1"
release_root="${SERVER_FOUNDATION_RELEASE_ROOT:-/opt/server-foundation/releases}"
current_link="${SERVER_FOUNDATION_CURRENT_LINK:-/opt/server-foundation/current}"
service="${SERVER_FOUNDATION_SERVICE:-server-foundation}"
health_url="${SERVER_FOUNDATION_HEALTH_URL:-http://127.0.0.1:8787/health/ready}"
target="$release_root/$release_id"

if [ ! -d "$target" ]; then
  echo "release does not exist: $target" >&2
  exit 1
fi

# ⚠️ 與 install-release.sh 同一個坑：current 不存在時 `readlink -f` 會回傳路徑本身，
#    導致失敗回滾時把 current 指向自己（自環，服務再也起不來）。詳細說明見該檔。
#    這裡 current 通常是存在的，但它若已經壞掉就會複製出同樣的自環。
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
  echo "rollback target $release_id is healthy and active"
  exit 0
fi

echo "rollback target $release_id failed readiness check" >&2
if [ -n "$previous" ] && [ "$previous" != "$current_link" ] && [ -d "$previous" ]; then
  rm -f "$next_link"
  ln -s "$previous" "$next_link"
  mv -Tf "$next_link" "$current_link"
  systemctl restart "$service"
  echo "restored previous current symlink to $previous" >&2
fi
exit 1
