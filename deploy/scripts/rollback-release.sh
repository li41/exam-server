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

# MUTATION #14: restore the historical current resolution bug.
previous="$(readlink -f "$current_link" 2>/dev/null || true)"
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
# MUTATION #14: remove the second self-loop guard so the historical defect is observable.
if [ -n "$previous" ] && [ -d "$previous" ]; then
  rm -f "$next_link"
  ln -s "$previous" "$next_link"
  mv -Tf "$next_link" "$current_link"
  systemctl restart "$service"
  echo "restored previous current symlink to $previous" >&2
fi
exit 1
