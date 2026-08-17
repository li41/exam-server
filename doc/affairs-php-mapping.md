# Affairs A-wave PHP mapping

Issue: #57 `WO-AFFAIRS-TO-SERVER`

This document records the A-wave behavior copied from the PHP truth source. It intentionally does not claim that B/C/D-wave tables or workflows are implemented.

## Scope and source coordinates

A-wave tables:

1. `config/db/exam_tw.sql` — `exam_affairs`
2. `config/db/exam_tw.sql` — `exam_affair_cities`
3. `config/db/exam_tw.sql` — `exam_affair_schools`

Behavior sources read for this wave:

- `src/Models/ExamAffair.php`
- `src/Models/ExamAffairCity.php`
- `src/Models/ExamAffairSchool.php`
- `src/Pages/Ajax/AffairAjaxActions.php`
- `src/Pages/Ajax/AffairCityAjaxActions.php`
- `src/Pages/Ajax/AffairSchoolAjaxActions.php`

## A-wave decisions

### `exam_affairs` -> `affairs`

The server keeps the PHP master fields: tenant/company ownership, creator, name, description, enabled/disabled status, city/school login windows, fee configuration, transport-receipt switches, `briefing_regions`, receipt year/note/print switches, timestamps.

PHP list/detail/simple-list queries always narrow by `company_id`. The MySQL adapter therefore includes `tenant_id` in every affair list/get/update query. Creation derives `tenant_id` and `created_by` from the authenticated scope instead of accepting them in the payload.

PHP create requires a non-empty trimmed name and starts enabled. Server create follows that behavior. PATCH has no nested defaults: omitted fields remain unchanged.

**Affair hard-delete is deliberately not exposed in A wave.** PHP deletion is not a simple row delete: before deleting it checks schools plus B/C/D-wave `exam_affair_submissions`, `exam_affair_receipts`, and `exam_affair_collections`. Implementing only the school check now would encode an incomplete safety rule. The A-wave schema additionally uses `ON DELETE RESTRICT` for tenant-scoped school ownership. Affair deletion must be added with the dependent-wave rules when those tables exist on server.

### `exam_affair_cities` -> `affair_cities`

PHP cities belong to the company, not to a single affair. Server preserves that shape: rows have `tenant_id` and no `affair_id`.

`ExamAffairCity::CITY_LIST` contains exactly 22 rows. `initializeForCompany()` skips existing `(company_id, city_code)` rows and creates:

- account: `EDU` + two-digit city code
- password: `EDU` + two-digit city code

This actual initializer behavior wins over the DDL's generic password default. Server initialization is idempotent through tenant-scoped unique keys and `INSERT IGNORE`.

PHP city update requires a non-empty password and validates a non-empty email. Server PATCH validates the same value shapes while using optimistic `version` checks. PHP Excel city import is not part of A-wave CRUD and is intentionally not implemented here.

### `exam_affair_schools` -> `affair_schools`

Server preserves `affair_id` plus tenant/company ownership, city, school level, code/name, test-class/session counts, receipt code, briefing options, password, contacts/setup JSON, status and timestamps.

PHP `validateSchoolInput()` establishes these rules:

- affair is required and must belong to the current company;
- city is required;
- school level is 1/2/3;
- school code and school name are required;
- test classes is 1 or 2;
- test sessions is 1, 2 or 3;
- receipt code is nullable; when present it is exactly three digits;
- an empty create password defaults to the school code.

PHP uniqueness is `(affair_id, school_code, school_level)`. Server enforces the same identity with a tenant-qualified unique key `(tenant_id, affair_id, school_level, school_code)`.

The MySQL foreign key is also tenant-qualified: `(tenant_id, affair_id) -> affairs(tenant_id, id)`. School create first resolves the affair using both id and tenant, and every school read/update/delete includes `tenant_id`.

PATCH intentionally cannot change `affairId`, matching PHP update's `unset($data['affair_id'])` behavior.

PHP school Excel import, clear-all cascading deletion, teacher export, account status, contact setup and password-reset workflows are not implemented in A wave. Those operations touch broader import/auth/receipt behavior and should be handled by their own follow-up scope.

## API surface added

Both legacy `/api` and versioned `/api/v1` mount the same A-wave routes:

- `GET /affairs`
- `GET /affairs/:id`
- `POST /affairs`
- `PATCH /affairs/:id`
- `GET /affair-cities`
- `POST /affair-cities/initialize`
- `PATCH /affair-cities/:id`
- `GET /affair-schools?affairId=...`
- `GET /affair-schools/:id`
- `POST /affair-schools`
- `PATCH /affair-schools/:id`
- `DELETE /affair-schools/:id?version=...`

Mutations use the same authentication and idempotency pattern as the existing question/examinee routes. A successful mutation is not rewritten to 500 if the idempotency completion record itself fails; that failure is logged as `idempotency_commit_failed`.

## B/C/D structural findings for follow-up tickets

The architecture/work-order count of 13 affair tables is confirmed. Besides the three A-wave tables, the PHP DDL currently contains these ten tables:

### B wave — collection/form configuration

- `exam_affair_collections`: affair/company, name, `type` (`form|excel|receipt`), `target` (`school|city`), sort/status/settings JSON.
- `exam_affair_excel_fields`: company-owned reusable field definitions with data type, required flag, validation JSON, options JSON and sort order.
- `exam_affair_excel_field_bindings`: collection-to-field binding with required override and sort order.
- `exam_affair_excel_ref_data`: collection-owned reference rows in `row_data` JSON.
- `exam_affair_form_ref_data`: collection-owned reference rows in `row_data` JSON.

### C wave — submissions

- `exam_affair_submissions`: affair/collection/company plus submitter type, nullable school/city owner, account type and draft/submitted/returned lifecycle.
- `exam_affair_submission_data`: normalized field/value records per submission.
- `exam_affair_submission_rows`: repeated/imported row JSON per submission.

### D wave — receipts/audit

- `exam_affair_receipts`: affair/company/submitter ownership plus substantial PII, encrypted identity/bank/contact fields, blind-index fields, bankbook image, position/transport fields and agreement state.
- `exam_affair_receipt_access_logs`: backend/school/city actor, action (`list|view|print|export|delete`), optional receipt id, count, IP and timestamp. PHP intentionally keeps this audit table independent enough to outlive deleted business rows.

Important follow-up dependency: PHP affair deletion checks schools, submissions, receipts and collections before deletion. The later migrations/routes must preserve those blockers instead of relying on cascades.

## Tenant-isolation oracles

The intended behavior oracles are:

- affair list/get/update cannot see or alter another tenant;
- city list/update/initialization is tenant scoped;
- school list/get/create/update/delete is tenant scoped;
- school create cannot reference an affair from another tenant;
- school unique identity is tenant + affair + school level + school code.

`apps/api/test/affairs.test.ts` contains an in-memory cross-tenant oracle. The MySQL adapter repeats tenant predicates in every A-wave SQL path and adds tenant-qualified foreign/unique keys.

The requested widening (`OR 1=1`) and reverse (`AND 1=0`) mutation runs require an executable checkout plus MySQL integration environment. In the current agent environment the GitHub repository cannot be materialized (outbound GitHub DNS is unavailable), so those mutation runs were **not executed** here and are not claimed as PASS.

## Verification status at authoring time

- Full `pnpm verify`: **not executed** — no local checkout can be materialized in this execution environment.
- Unit tests, including `apps/api/test/affairs.test.ts`: **not executed locally** for the same reason.
- MySQL 8.4 integration: **not executed locally**.
- Redis integration: **not executed locally**.
- N-1 migrated-schema check: **not executed locally**.
- Backup/restore rehearsal: **not executed locally**.
- Tenant widening/reverse mutations: **not executed locally**.

The existing GitHub `Verify` workflow is left unchanged. It triggers on pull requests and is the first environment capable of running the complete repository verification for this branch.
