# Affair hard-delete blocker parity

This note records the behavior implemented for `WO-AFFAIRS-DELETE-RULES` and the database boundary relied on by `DELETE /api/v1/affairs/:id?version=...`.

## PHP source behavior

The current PHP affair delete action is **first-blocker-wins**, not an aggregate response. It checks the four blocker classes in this order and immediately returns HTTP 400 on the first non-zero count:

1. schools
   - `此試務資料下有 {count} 所學校帳號，請先刪除學校帳號後再刪除`
2. submissions
   - `此試務資料下有 {count} 筆填報資料，請先到各收集方式的「資料檢視」頁刪除後再刪除試務`
3. receipts
   - `此試務資料下有 {count} 筆領據（含身分證與銀行帳號），請先到領據頁面刪除後再刪除試務`
4. collections
   - `此試務資料下有 {count} 個收集方式，請先刪除收集方式後再刪除`

Only when all four counts are zero does PHP delete the affair. The inspected PHP action does not expose a force-delete/cascade affair endpoint that bypasses these four blockers.

The exam-server domain service preserves the same order and user-visible strings. The MySQL repository performs the count checks in the same order and returns only the first blocker.

## Concurrency boundary

The blocker inspection and the parent delete execute inside one `withTransaction()` call. The code does **not** override MySQL transaction isolation, so the effective isolation level is whatever the MySQL session/server is configured to use; no claim is made that it is always `REPEATABLE READ` or always `READ COMMITTED`.

Inside the transaction the repository first performs:

```sql
SELECT version
FROM affairs
WHERE id = ? AND tenant_id = ?
FOR UPDATE
```

This is a tenant-qualified locking read on the parent row. The existing child schemas also retain composite tenant FKs back to the affair and use `ON DELETE RESTRICT`:

- `affair_schools (tenant_id, affair_id)`
- `affair_submissions (tenant_id, affair_id)`
- `affair_receipts (tenant_id, affair_id)`
- `affair_collections (tenant_id, affair_id)`

For InnoDB, a concurrent insert of one of those child rows must validate its parent FK. The locked affair record therefore prevents that child write from cleanly slipping between the blocker inspection and the final parent delete. `ON DELETE RESTRICT` remains the last database integrity boundary if an unexpected dependent row is present.

The final delete is also tenant- and version-qualified:

```sql
DELETE FROM affairs
WHERE id = ? AND tenant_id = ? AND version = ?
```

### What this does not protect

This guarantee depends on the modeled child tables continuing to use InnoDB/FK enforcement and on those relations continuing to point at the tenant-qualified affair parent. A future child table without an affair FK, an external data store, a disabled-FK maintenance session, or another out-of-band write path is outside this lock/FK proof. An unexpected FK restriction at the final delete is surfaced as a conflict rather than silently cascading data.

## Tenant boundary

Every parent lock, blocker count, and final delete includes `tenant_id`. The integration test also deliberately disables FK checks to manufacture otherwise-invalid foreign-tenant child rows that reuse the target affair id, then verifies that none of the four blocker queries widen across tenants. A delete attempted with the wrong tenant scope returns not-found and preserves the real tenant's affair.

## Partial failure semantics

The affair deletion path does not delete child rows. It only reads blocker counts and, when all are zero, deletes the parent row.

- If a blocker is found, the transaction completes without changing business rows.
- If any SQL operation throws before commit, `withTransaction()` rolls back the parent delete.
- If the final parent delete is rejected by an FK or other database error, the parent remains because the transaction rolls back.
- There is therefore no multi-table partial child cleanup in this endpoint; callers must explicitly remove blocking business rows through their own flows first.

## Receipt audit survival

`affair_receipt_access_logs` deliberately has no FK to `affair_receipts` or `affairs`, so audit evidence is not cascaded with business rows. Receipt deletion records `action=delete` before deleting the receipt row. The inherited receipt integration test proves that the audit row survives receipt deletion, and the affair-deletion integration test additionally deletes the now-unblocked affair and verifies the receipt audit row still remains.

## Verification coverage

Tests on this branch cover:

- exact PHP HTTP 400 message for each of the four blocker categories;
- first-blocker ordering rather than aggregation;
- successful 204 hard-delete when all counts are zero;
- MySQL-backed positive cases for schools, submissions, receipts, and collections;
- wrong-tenant delete rejection;
- forced cross-tenant widening mutations for all four child categories;
- receipt `action=delete` audit evidence surviving both receipt deletion and later affair deletion.

These tests are committed as evidence. Their execution status must be reported separately; adding the tests does not imply they were run or passed in a connector-only environment.
