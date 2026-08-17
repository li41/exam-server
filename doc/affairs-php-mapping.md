# Affairs PHP mapping

Issues: #57 `WO-AFFAIRS-TO-SERVER`, #59 `WO-AFFAIRS-TO-SERVER-B`, #61 `WO-AFFAIRS-TO-SERVER-C`

This document records the PHP truth-source mapping for the implemented A, B and C waves. D-wave receipt structures remain documented only for dependency planning and are not claimed as implemented.

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

## Verification status at A-wave authoring time

- Full `pnpm verify`: **not executed** — no local checkout can be materialized in this execution environment.
- Unit tests, including `apps/api/test/affairs.test.ts`: **not executed locally** for the same reason.
- MySQL 8.4 integration: **not executed locally**.
- Redis integration: **not executed locally**.
- N-1 migrated-schema check: **not executed locally**.
- Backup/restore rehearsal: **not executed locally**.
- Tenant widening/reverse mutations: **not executed locally**.

The existing GitHub `Verify` workflow is left unchanged. It triggers on pull requests and is the first environment capable of running the complete repository verification for this branch.

---

# B-wave addendum — collection/form/excel configuration

Issue: #59 `WO-AFFAIRS-TO-SERVER-B`

B wave is stacked on `codex/57-affairs-a-wave`; it does not include or depend on the company-member branch.

## PHP truth sources re-read for B wave

DDL:

- `config/db/exam_tw.sql` — `exam_affair_collections`
- `config/db/exam_tw.sql` — `exam_affair_excel_fields`
- `config/db/exam_tw.sql` — `exam_affair_excel_field_bindings`
- `config/db/exam_tw.sql` — `exam_affair_excel_ref_data`
- `config/db/exam_tw.sql` — `exam_affair_form_ref_data`

Behavior:

- `src/Models/ExamAffairCollection.php`
- `src/Models/ExamAffairExcelField.php`
- `src/Models/ExamAffairExcelFieldBinding.php`
- `src/Pages/Ajax/AffairAjaxActions.php`
- `src/Pages/Ajax/AffairFieldAjaxActions.php`
- `src/Pages/Ajax/AffairFormAjaxActions.php`
- `src/Pages/Manage/affairCreateView.php`

## B-wave table decisions

### `exam_affair_collections` -> `affair_collections`

The PHP enum is preserved exactly: `form | excel | receipt`. `receipt` is a valid collection definition in this wave even though receipt records and receipt workflows remain D wave.

Collections are affair-owned and company-owned in PHP. Server stores `tenant_id + affair_id` and uses a tenant-qualified FK to A-wave `affairs`. PHP DDL uses `ON DELETE CASCADE`, but PHP application deletion first checks dependent collections/submissions/receipts. Server therefore uses `ON DELETE RESTRICT` and still does **not** expose affair hard-delete.

PHP create validates that the affair belongs to the current company, auto-assigns the next sort order and allows only one `receipt` collection per `(affair, target)`. Server copies those behaviors. PHP update does not change the collection type; server PATCH likewise exposes name/target/status/sort only.

B wave supports `target=city`, but it does not alter city credentials. The A-wave PHP truth source still initializes every city with predictable `EDU{city_code}` account **and password**. This is a pre-existing PHP credential defect; server preserves it for behavioral parity in A wave and B wave does not silently change it.

**Collection delete is deliberately deferred.** PHP `doAffairCollectionDelete()` blocks deletion when C-wave submissions exist and, for receipt collections, when D-wave receipts exist. Those blockers cannot yet be represented on server without inventing an incomplete rule. Binding/reference-data cleanup is supported through replacement APIs, but collection deletion itself waits for C/D.

### `settings` JSON

PHP `ExamAffairCollection::updateSetting()` is generic, but the actual B-wave caller only writes the form `layout`. Server therefore defines a strict named settings contract containing only optional `layout`; unknown JSON keys are rejected instead of being silently stored. Form binding replacement may update `layout`; excel/receipt collections may not define it.

### `exam_affair_excel_fields` -> `affair_excel_fields`

This table is tenant/company-owned reusable configuration and intentionally has no `affair_id`.

PHP data types are exactly `text | number | date | time | select`. Name is required and PHP rejects duplicate names inside the same company. Server backs that behavior with a tenant-scoped unique key as well as API validation.

For `select`, PHP requires at least one select option. Server models `selectOptions` as a named string-array contract rather than arbitrary JSON. Non-select fields may not carry select options.

The PHP DDL and model summary are incomplete descriptions of the validation JSON. Re-reading the actual `AffairFieldAjaxActions::parseFieldValidation()` write path found these emitted keys:

- `min`, `max`
- `min_length`, `max_length`
- `min_date`, `max_date`
- `min_time`, `max_time`
- `pattern`, `pattern_desc`

The date/time keys were not listed in the issue summary and are also absent from the model's `defaultValidation()` helper. The Ajax write path is used as the truth source. Server uses a strict schema for exactly these keys, so an undefined validation key is detectable and rejected.

PHP field deletion refuses to delete a field while any binding uses it. Server implements the same blocker and additionally uses an FK with `ON DELETE RESTRICT`. Server uses optimistic `version` on field update/delete; PHP did not have that concurrency token.

### `exam_affair_excel_field_bindings` -> `affair_excel_field_bindings`

PHP intentionally uses the same binding table for both form and excel collections. `batchSave()` replaces the whole ordered list and records the per-collection required override.

Before saving, PHP verifies every `field_id` exists under the current company and rejects duplicate field IDs. Server does the same. The server table additionally stores `tenant_id`, and both relationships are tenant-qualified:

- `(tenant_id, collection_id) -> affair_collections(tenant_id, id)`
- `(tenant_id, field_id) -> affair_excel_fields(tenant_id, id)`

This makes a cross-tenant collection/field binding invalid even if application filtering is accidentally bypassed.

### `exam_affair_form_ref_data` and `exam_affair_excel_ref_data`

The two PHP tables remain two server tables. They share a storage implementation path but **not** row-data semantics:

- form import uses spreadsheet header names as `row_data` keys;
- excel import uses bound `field_id` values as `row_data` keys, in binding order.

Server reference rows are flat string maps. For excel reference data, keys must exactly match the current bound field IDs. Form rows accept their header-name keys. Replacement and clear operations choose the table from the collection type; receipt collections cannot use reference data.

This wave implements the reference-data storage lifecycle as JSON list/replace/clear API. It does **not** add spreadsheet XLSX/ODS/CSV parsing/upload endpoints; that parser/import UI is intentionally left outside this storage-focused B-wave delivery.

## B-wave API surface

Both `/api` and `/api/v1` expose:

- `GET /affair-collections?affairId=...`
- `GET /affair-collections/:id`
- `POST /affair-collections`
- `PATCH /affair-collections/:id`
- `GET /affair-collections/:id/bindings`
- `PUT /affair-collections/:id/bindings`
- `GET /affair-collections/:id/reference-data`
- `PUT /affair-collections/:id/reference-data`
- `DELETE /affair-collections/:id/reference-data`
- `GET /affair-fields`
- `GET /affair-fields/:id`
- `POST /affair-fields`
- `PATCH /affair-fields/:id`
- `DELETE /affair-fields/:id?version=...`

B-wave mutating routes preserve the existing authentication/idempotency completion-failure behavior. `PUT` replacement endpoints are also covered by idempotency middleware.

## B-wave tenant oracles

Behavior tests added:

- in-memory: a tenant-A collection cannot bind a tenant-B field; a same-tenant field can bind;
- MySQL integration: the repository rejects the cross-tenant field and a direct cross-tenant binding insert is also rejected by the tenant-qualified FK;
- list/get paths for collections and fields do not expose another tenant;
- API tests exercise strict validation JSON, select-options rules, form/excel shared binding behavior and distinct reference-data key semantics.

The requested `OR 1=1` widening and reverse `AND 1=0` mutation executions are **not claimed** here because this agent still has no executable repository checkout/MySQL service. The MySQL integration oracle is intentionally shaped so those mutations can be run by the owner/CI environment.

## B-wave intentionally not implemented / not verified here

Not implemented:

- affair hard-delete;
- collection delete, because PHP deletion depends on C/D submissions/receipts;
- receipt record/workflow behavior (D wave);
- form/excel spreadsheet upload/parser endpoints;
- C-wave submissions and D-wave receipts/audit.

Not executed in this agent environment:

- full `pnpm verify`;
- typecheck, lint, Prettier format check, unit tests and build;
- MySQL 8.4 integration, including the new tenant-binding oracle;
- Redis integration;
- N-1 migrated-schema application;
- backup/restore rehearsal;
- tenant widening `OR 1=1` mutation;
- reverse `AND 1=0` mutation.

None of the unexecuted checks above are claimed as PASS. No `.github/`, `deploy/`, `scripts/`, secret or deployment changes are part of B wave.

---

# C-wave addendum — submissions and repeated rows

Issue: #61 `WO-AFFAIRS-TO-SERVER-C`

C wave is stacked directly on `codex/59-affairs-b-wave`. It implements the three PHP submission tables without changing the D-wave receipt model or enabling the still-incomplete affair/collection hard-delete rules.

## PHP truth sources re-read for C wave

DDL:

- `config/db/exam_tw.sql` — `exam_affair_submissions`
- `config/db/exam_tw.sql` — `exam_affair_submission_data`
- `config/db/exam_tw.sql` — `exam_affair_submission_rows`

Behavior:

- `src/Models/ExamAffairSubmission.php`
- `src/Models/ExamAffairSubmissionData.php`
- `src/Models/ExamAffairSubmissionRow.php`
- `src/Pages/Affair/Traits/AffairSchoolActions.php`
- `src/Pages/Affair/Traits/AffairCityActions.php`
- `src/Pages/Ajax/AffairDataAjaxActions.php`

## C-wave decisions

### `exam_affair_submissions` -> `affair_submissions`

PHP stores affair, collection and company ownership, `submitter_type`, nullable `school_id`/`city_id`, account type, `draft|submitted|returned`, return reason/time, submit time and timestamps. Server stores the same business state plus the existing server-side optimistic `version` field.

PHP DDL itself does **not** enforce the issue's `school_id`/`city_id` XOR. The normal PHP constructors do: `getOrCreateForSchool()` writes `school_id` and leaves `city_id` null; `getOrCreateForCity()` writes `city_id` and leaves `school_id` null. C-wave server is deliberately stricter than the PHP DDL while matching every normal PHP write path: the API uses a discriminated school/city identity contract and migration `012_affair_submissions.sql` adds `chk_affair_submission_owner`, requiring exactly the owner selected by `submitter_type`.

Tenant ownership is qualified at every layer. Server adds `(tenant_id,id)` uniqueness to `affair_cities` in migration 012 so city ownership can use the same composite-FK shape as affairs, collections and schools. Submission FKs use tenant + parent id. Affair, collection, school and city parent deletes are `RESTRICT`; child submission data/rows cascade only when a submission itself is deliberately deleted.

PHP uniqueness is one submission per school+collection or city+collection. Server preserves that identity with tenant-qualified unique keys.

### Status machine copied from PHP

Reading the school and city handlers resolves the legal transitions:

- `draft -> submitted`: allowed by submit;
- `returned -> submitted`: allowed directly by submit;
- `submitted -> returned`: allowed by return;
- `returned -> draft`: happens only when a returned submission is saved as a draft;
- `submitted -> draft`: not allowed; save rejects submitted data;
- `draft -> returned`: not exposed by PHP and not exposed by server.

PHP does not clear the old `return_reason` or `returned_at` when a returned submission is saved or re-submitted. Server preserves those historical fields too; only status and the new `submitted_at`/`updated_at` are changed on resubmit.

The backend PHP return action accepts an empty reason and stores null. The city-facing return action requires a non-empty reason. The C-wave server API is a tenant-authenticated management API and follows the backend action's optional reason behavior; it does not replace the existing PHP city frontend or its stricter UI rule.

### `exam_affair_submission_data` -> `affair_submission_data`

This is the normalized form-value path: `submission + field + value`. PHP `batchSave()` upserts only field IDs present in the request and does **not** delete omitted saved values. Server preserves that behavior. On final submit, validation merges already-saved values with incoming values so an omitted-but-already-saved required field remains present, matching PHP.

Every submitted field ID must be currently bound to that collection and belong to the same tenant. The domain service checks B-wave bindings, the MySQL repository repeats that check immediately before writing, and the child table uses tenant-qualified FKs to both submission and `affair_excel_fields`. A foreign-tenant field therefore fails both the behavioral oracle and direct-SQL FK oracle.

### `exam_affair_submission_rows` -> `affair_submission_rows`

This is the repeated/import-row path. PHP `batchSave()` deletes all existing rows for the submission and recreates them in order; C-wave server does the same. `row_data` remains JSON with field IDs as keys, but it is not treated as unrestricted JSON: request rows have a strict named wrapper and every dynamic field-ID key is checked against the collection's current bindings. Unknown/unbound keys are rejected.

The issue text warns not to collapse `submission_data` and `submission_rows`. They remain separate tables and repository paths. Actual PHP save/submit handlers choose the path from collection type (`form` writes normalized field values; `excel` writes repeated rows), so the server follows that concrete behavior rather than inventing a write path that stores both for one normal collection submission. The schema still keeps both child tables independently, matching PHP storage.

### Final-submit validation

The C-wave service copies the actual `AffairSchoolActions::validateSingleField()` behavior from PHP:

- required override comes from the collection binding;
- number fields use numeric validation plus min/max;
- `min_length` / `max_length` apply to every non-empty value, not only text fields;
- date/time min/max use the same lexical comparison shape;
- configured pattern validation is applied;
- Excel final submit requires at least one row.

PHP does **not** re-check `select_options` membership in this final-submit validator, so server deliberately does not add such a check here. B-wave field configuration still requires select fields to have configured options.

## C-wave API surface

Both `/api` and `/api/v1` expose:

- `GET /affair-submissions?collectionId=...`
- `GET /affair-submissions/:id`
- `POST /affair-submissions/ensure`
- `PUT /affair-submissions/:id/draft`
- `POST /affair-submissions/:id/submit`
- `POST /affair-submissions/:id/return`
- `POST /affair-submissions/batch-return`
- `DELETE /affair-submissions/:id?version=...`

Mutating C-wave routes use the existing authentication/idempotency pattern, including the already-fixed behavior where failure to persist the idempotency completion record is logged instead of rewriting a successful mutation to HTTP 500.

PHP generic `AccessLog::log()` is best-effort and swallows audit-write failures. Server return/batch-return/delete therefore write through the existing `AuditLog` capability on a best-effort basis and log audit failures without changing an already-successful business response.

## C-wave tenant and behavior oracles

Added tests cover:

- school owner has `schoolId` only and city owner has `cityId` only;
- the DB `CHECK` rejects dual owners, and tenant-qualified FKs reject a foreign-tenant owner;
- a tenant-A submission cannot write a tenant-B field through the repository;
- a direct child insert using tenant A + tenant B field is rejected by the composite FK;
- form draft saves preserve omitted previously saved values;
- submitted data cannot be edited as draft;
- returned data becomes draft only when saved, and returned data may be submitted directly;
- Excel repeated rows are replaced in order;
- an extra wrapper property or unbound row field key is rejected;
- final Excel submit rejects an empty row list.

The requested widening (`OR 1=1`) and reverse (`AND 1=0`) mutation executions are not claimed in this agent environment. The MySQL integration test intentionally gives future CI/owner mutation runs direct tenant/field/owner behavior oracles.

## C-wave intentionally not implemented / not verified here

Not implemented:

- affair hard-delete: D-wave receipts are still missing, so PHP's complete blockers still cannot be represented;
- collection hard-delete for the same cross-wave reason;
- D-wave receipt records and receipt-access audit model;
- replacement of the existing PHP school/city frontend authentication, dashboards or UI;
- PHP spreadsheet/report export endpoints for submission data; this wave implements submission persistence/state operations, not file export UI.

Not executed in this agent environment at authoring time:

- full `pnpm verify`;
- typecheck, oxlint, Prettier `format:check`, workspace unit tests and build;
- `apps/api/test/affair-submissions.test.ts`;
- MySQL 8.4 integration, including `affair-submission-repository.integration.test.ts`;
- Redis/backing-service integration;
- N-1 migrated-schema application;
- backup/restore rehearsal;
- tenant widening `OR 1=1` mutation;
- reverse `AND 1=0` mutation.

None of those unexecuted checks are claimed as PASS. C wave does not modify `.github/`, `deploy/`, `scripts/`, secrets, CI gates or deployment configuration.
