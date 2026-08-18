# Affair delete PHP mapping

Issue: #65 `WO-AFFAIRS-DELETE-RULES`

Base: `codex/62-affairs-d-receipts`

This document records the PHP truth source and the server-side concurrency/integrity decisions for deleting an affair after A/B/C/D data structures exist.

## PHP truth source

Primary handler read:

- `exam.tw/src/Pages/Ajax/AffairAjaxActions.php` — `doAffairDelete()`

### 1. Blockers are **not aggregated**

PHP checks one category at a time and returns immediately on the first non-zero count. The exact order is:

1. schools
2. submissions
3. receipts
4. collections

The user therefore sees only the first blocker. Server intentionally preserves this behavior instead of returning a combined dependency summary.

### 2. Exact PHP messages

For count `N`, the handler returns HTTP 400 with these message strings:

- schools: `此試務資料下有 N 所學校帳號，請先刪除學校帳號後再刪除`
- submissions: `此試務資料下有 N 筆填報資料，請先到各收集方式的「資料檢視」頁刪除後再刪除試務`
- receipts: `此試務資料下有 N 筆領據（含身分證與銀行帳號），請先到領據頁面刪除後再刪除試務`
- collections: `此試務資料下有 N 個收集方式，請先刪除收集方式後再刪除`

The server `AffairDeletionService` uses those strings verbatim and maps a blocker to `validation_error` / HTTP 400.

### 3. Force delete

The measured management deletion handler has no `force` parameter and no cascade/force branch. It only deletes the affair after all four counts are zero.

The connector's repository-wide code-search index did not return reliable matches for the deletion token during this run, so this document does **not** claim that no unrelated/internal direct model delete call exists anywhere in the PHP repository. What is confirmed is that the actual management Ajax deletion path has no force-delete behavior. The server exposes no force-delete endpoint.

## Server API

Both `/api` and `/api/v1` expose:

- `DELETE /affairs/:id?version=...`

The route uses the existing affair authentication and idempotency middleware. The production/MySQL server injects `MySqlAffairDeletionRepository`. A no-MySQL in-memory server does not pretend to provide a correct four-table delete coordinator; the route returns `capability_missing` when the deletion repository is absent.

## Concurrency decision

### Chosen method

`MySqlAffairDeletionRepository.deleteAffair()` performs the complete decision inside one MySQL transaction:

1. `SELECT version FROM affairs WHERE id = ? AND tenant_id = ? FOR UPDATE`
2. check `affair_schools` count, tenant + affair narrowed
3. check `affair_submissions` count, tenant + affair narrowed
4. check `affair_receipts` count, tenant + affair narrowed
5. check `affair_collections` count, tenant + affair narrowed
6. `DELETE FROM affairs WHERE id = ? AND tenant_id = ? AND version = ?`
7. commit

The parent row is locked before any blocker count is observed.

### Isolation level and why the lock is sufficient

The design relies on InnoDB locking reads and the existing tenant-qualified foreign keys, not on a repeatable-read snapshot alone.

Under InnoDB **READ COMMITTED** and **REPEATABLE READ**, `SELECT ... FOR UPDATE` takes an exclusive record lock on the selected affair row. A concurrent child insert that enforces one of the existing `(tenant_id, affair_id) -> affairs(tenant_id, id)` foreign keys needs to validate/lock that parent record and therefore cannot slip between the blocker check and parent delete; it waits until the deletion transaction commits or rolls back. If the parent is deleted, the waiting child insert cannot subsequently satisfy the FK.

Existing `ON DELETE RESTRICT` foreign keys remain the final integrity boundary. If a new/unmodeled child relation appears and blocks the final delete, the adapter converts the FK failure to a conflict instead of allowing an orphan.

### What this does **not** protect against

The guarantee assumes normal InnoDB transactions with foreign-key enforcement enabled. It does not make these cases safe by magic:

- a privileged/out-of-band writer using `FOREIGN_KEY_CHECKS=0`;
- a future child store outside MySQL or without an FK to the affair;
- a non-InnoDB storage engine with different locking semantics;
- an infrastructure failure during `COMMIT`, where the client may not be able to determine whether the commit reached durable storage.

Those are explicitly outside the transaction guarantee and must not be described as fully atomic.

## Partial failure

Affair deletion does **not** delete any child rows. It only reads blocker counts and deletes the parent after all four categories are empty.

Consequences:

- failure during any blocker query -> transaction rolls back; parent remains;
- first blocker found -> no mutation occurs; transaction ends and parent remains;
- failure during parent delete -> transaction rolls back;
- FK rejection at final delete -> transaction rolls back and is surfaced as conflict;
- successful delete + successful commit -> only the affair parent row is removed;
- no schools/submissions/receipts/collections are partially deleted because this path never deletes them.

This is intentionally different from a "force cascade" implementation.

## Receipt access logs must outlive business rows

D wave deliberately created `affair_receipt_access_logs` with no FK to `affair_receipts` and no FK to `affairs`. This delete implementation does not touch that table.

The #65 MySQL integration test writes a receipt access event with `action = delete`, deletes the receipt business row, then deletes the now-unblocked affair, and finally queries the audit row by tenant + receipt id. The expected result is that the audit row is still present after both business rows are gone.

This test is written but was not executed in the current agent environment.

## Tenant narrowing and mutation oracles

Every #65 MySQL query includes `tenant_id`:

- parent `FOR UPDATE` lookup;
- schools count;
- submissions count;
- receipts count;
- collections count;
- final parent delete.

The MySQL integration test contains two styles of tenant oracle:

1. tenant B cannot delete tenant A's affair by id;
2. for **each** blocker table, the test temporarily disables FK checks and inserts a deliberately malformed tenant-B child row carrying tenant A's affair id. Tenant A's delete must ignore that row and succeed. Removing the tenant predicate from the corresponding count query would make that test block and therefore turn the oracle red.

The test intentionally re-enables `FOREIGN_KEY_CHECKS` before executing the repository deletion. The malformed rows exist only to make tenant-widening behavior observable.

## Tests added

- `apps/api/test/affair-delete.test.ts`
  - exact PHP message for each of the four blockers;
  - first-blocker ordering;
  - successful 204 deletion;
  - cross-tenant rejection.
- `packages/adapters/mysql/test/affair-deletion-repository.integration.test.ts`
  - each blocker independently stops deletion;
  - submissions win before their required collection;
  - successful deletion when all four are empty;
  - cross-tenant parent delete rejected;
  - foreign-tenant widening oracle for all four blocker queries;
  - receipt access log survives receipt + affair business-row deletion.

## Verification status in this agent environment

The repository still cannot be materialized/executed locally in this environment, so none of the following are claimed as PASS:

- full `pnpm verify`: **not executed**;
- typecheck: **not executed**;
- oxlint: **not executed**;
- Prettier `format:check`: **not executed**;
- workspace unit tests: **not executed**;
- `apps/api/test/affair-delete.test.ts`: **not executed**;
- MySQL 8.4 integration, including #65 oracles: **not executed**;
- Redis/API backing-service integration: **not executed**;
- N-1 migrated-schema application: **not executed**;
- backup/restore rehearsal: **not executed**;
- actual source mutation run with `OR 1=1`: **not executed**;
- reverse `AND 1=0` mutation run: **not executed**.

The tests/oracles are present so the owner/CI environment can execute those checks. No CI gate, deploy file, script, secret, or schema migration was changed for #65.
