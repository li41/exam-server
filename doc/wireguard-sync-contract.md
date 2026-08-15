# WireGuard peer sync contract check

`exam-server` consumes the approved-peer response owned by `li41/exam-control`.
The authoritative control-side sources named by WO-WG-SYNC-CONTRACT-ORACLE are:

- `packages/desktop-contracts/src/wire/index.ts`
- `src/routes/wg-approved-peers.ts`

## Why the oracle is not automatically cross-repo in GitHub Actions yet

The repositories are separate and the current `exam-server` GitHub Actions checkout does not contain
`exam-control`. The repository-scoped `GITHUB_TOKEN` also does not grant this workflow read access to a
separate private repository. Copying a control fixture into this repository would not solve the problem:
a copied fixture would stay unchanged when control changes.

For that reason `pnpm verify` always runs `wg:contract:check`, but the command is deliberately honest:

- if a real `exam-control` checkout is available, it reads the two authoritative files and fails on drift;
- if no real checkout is available, it prints `SKIP wg-control-contract: ...` instead of pretending the
  cross-repo comparison passed.

To run the real-source comparison with sibling checkouts:

```bash
EXAM_CONTROL_ROOT=../exam-control corepack pnpm wg:contract:check
```

or:

```bash
corepack pnpm wg:contract:check -- --control-root ../exam-control
```

The checker currently verifies the approved-peers path, the WireGuard public-key pattern, and the
response field names consumed by `validateApprovedPeers()`.

A future fully automatic CI oracle needs one of these external prerequisites:

1. a read-only cross-repository credential usable by `exam-server` Actions to checkout `exam-control`, or
2. a versioned contract artifact/package published by `exam-control` and consumed here.

Until one exists, the repo does not claim that a control commit automatically turns this repo's CI red.
The unit tests only prove that the checker itself turns red when the real source presented to it drifts.

## Token-name mapping

The same bearer-token value has two historical names:

- `exam-control`: `WG_SYNC_TOKEN`
- `exam-server`: `CF_TOKEN` in `/etc/server-foundation/wireguard-peer-sync.env`

`exam-server` keeps `CF_TOKEN` for compatibility with already-installed machines; this change does not
rewrite or expose existing credentials. The values **must be identical**.

If control returns HTTP 401, the synchronizer now fails with an explicit message naming this mapping:
check that `exam-control WG_SYNC_TOKEN` and `exam-server CF_TOKEN` contain the same token. The token value
itself is never included in the error or log message.

## Installer isolation check

The WireGuard bootstrap uses:

```text
/etc/server-foundation/wireguard-peer-sync.env
```

The off-site backup installer uses:

```text
/etc/server-foundation/offsite-backup.env
```

Both use their own exact file path, create only their own missing file, then chmod/chown only that file.
The off-site installer therefore does not overwrite or chmod the WireGuard credential file, and the
WireGuard bootstrap does not touch the R2 credential file.
