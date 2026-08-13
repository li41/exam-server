# Production deployment

This directory contains the single-VPS production baseline: Caddy terminates public HTTPS, the Node API listens on loopback, and MySQL/Redis remain private.

## Files

- `env/server-foundation.env.example`: root-owned production environment template.
- `systemd/server-foundation.service`: hardened systemd service using `/opt/server-foundation/current`.
- `caddy/Caddyfile.example`: HTTPS reverse proxy for the loopback API.
- `scripts/install-release.sh`: install a packaged release, migrate, atomically switch `current`, restart, health-check, and automatically switch back on failure.
- `scripts/rollback-release.sh`: explicitly switch `current` to an already-installed release and verify readiness.

## Host layout

```text
/opt/server-foundation/releases/<release-id>   immutable release directories
/opt/server-foundation/current                 symlink to active release
/etc/server-foundation/                        root-owned configuration
/var/lib/server-foundation/storage             private file storage
/var/backups/server-foundation                 backup destination
```

Create the service account and directories once:

```bash
sudo useradd --system --home /var/lib/server-foundation --shell /sbin/nologin server-foundation
sudo install -d -m 0700 -o server-foundation -g server-foundation /var/lib/server-foundation/storage
sudo install -d -m 0700 -o server-foundation -g server-foundation /var/backups/server-foundation
sudo install -d -m 0750 -o root -g server-foundation /etc/server-foundation
sudo install -d -m 0755 -o root -g root /opt/server-foundation/releases
sudo install -m 0600 -o root -g server-foundation deploy/env/server-foundation.env.example /etc/server-foundation/server-foundation.env
```

Replace all placeholder secrets. Keep MySQL and Redis on loopback/private interfaces or behind a firewall.

## Release artifacts

A `v*` Git tag runs `.github/workflows/release.yml`. A release is packaged only after `pnpm verify`, the production dependency audit, MySQL/Redis/API integration tests, the N-1 application migration compatibility gate, and the destructive backup/restore rehearsal succeed. The workflow uploads a `.tar.gz`, SHA-256 file, and JSON manifest.

The N-1 compatibility gate first runs the current migrations, then checks out the previous release (or previous application revision when no older release tag exists) and runs its integration suite against the migrated schema. This proves that code-only rollback remains viable after a forward-only schema change.

Install the artifact as root:

```bash
sudo deploy/scripts/install-release.sh ./server-foundation-v1.2.3.tar.gz v1.2.3
```

If the adjacent `.sha256` file is present, the installer verifies it first. It then extracts to a new immutable release directory, installs production dependencies, reads only `MYSQL_URL` from the root-owned environment file without evaluating it as shell code, runs migrations, atomically updates `/opt/server-foundation/current`, restarts systemd, and polls `/health/ready`. A failed readiness check automatically switches the symlink back to the previous release.

Migrations are forward-only. New schema changes must remain compatible with the immediately previous application release; CI and release packaging verify that property by running the previous application integration tests against the already-migrated database. Destructive schema rollback is an explicit database operation, not something the deployment script attempts automatically.

To roll back to a previously installed release:

```bash
sudo deploy/scripts/rollback-release.sh v1.2.2
```

## systemd and Caddy

Install the unit once and reload it after unit-file changes:

```bash
sudo install -m 0644 deploy/systemd/server-foundation.service /etc/systemd/system/server-foundation.service
sudo systemctl daemon-reload
sudo systemctl enable --now server-foundation
```

The application environment should normally keep:

```text
HOST=127.0.0.1
PORT=8787
TRUST_PROXY_HEADERS=true
IDEMPOTENCY_TTL_SECONDS=86400
```

`IDEMPOTENCY_TTL_SECONDS` applies to completed MySQL idempotency records. Ambiguous `pending` records intentionally do not automatically reopen after a short TTL; they fail closed to avoid duplicate side effects after a crash.

Only enable trusted proxy headers while clients cannot bypass Caddy and reach Node directly.

## Health and logs

Use `/health/live` for process liveness and `/health/ready` for MySQL, Redis, and storage readiness. JSON application logs are captured by journald:

```bash
journalctl -u server-foundation -f -o cat
```

Request bodies, authorization tokens, passwords, and idempotency response bodies are not written to structured logs or audit events.

## Backup and restore

Use a root-owned or backup-operator environment file rather than putting credentials on a command line. A normal backup requires `MYSQL_URL`, `FILE_STORAGE_ROOT`, and `BACKUP_ROOT`. The durable idempotency ledger is stored in MySQL and is therefore included in the database backup.

Run destructive restore only while the API is stopped:

```bash
sudo systemctl stop server-foundation
RESTORE_CONFIRM=YES BACKUP_DIR=/var/backups/server-foundation/backup-... corepack pnpm restore
sudo systemctl start server-foundation
```

Run `corepack pnpm backup:rehearse` only against an isolated test database/storage root. It intentionally mutates and restores both targets.
