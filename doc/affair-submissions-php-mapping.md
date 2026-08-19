# Affair submissions PHP mapping

Issue: #80 `WO-SERVER-PARITY-AFFAIR-SUBMISSIONS`

This document records a focused PHP parity audit for affair submissions. It
follows the structure of `doc/examinees-php-mapping.md` and narrows the older
C-wave implementation notes in `doc/affairs-php-mapping.md` to the actual PHP
read/write, exposure, authorization and numeric-semantics contracts.

This audit is documentation-only. It records confirmed gaps but does not repair
them in #80.

## Truth source read before implementation

Read-only references from `li41/exam.tw` at PHP main
`f615e7c05fd0d6180e55f1dd000775fd2a3e1497`:

- `config/db/exam_tw.sql`
- `src/Models/ExamAffairSubmission.php`
- `src/Models/ExamAffairSubmissionData.php`
- `src/Models/ExamAffairSubmissionRow.php`
- `src/Pages/Affair/Traits/AffairSchoolActions.php`
- `src/Pages/Affair/Traits/AffairCityActions.php`
- `src/Pages/Ajax/AffairDataAjaxActions.php`
- `src/Pages/Manage/Traits/AffairDataActions.php`
- `src/Pages/Manage/affairCollectionDataView.php`

Compared against `exam-server` main
`76a8db261b96ea46a60d134f05e2fcd6afdcb732`:

- `packages/api-contracts/src/affair-submissions.ts`
- `packages/domain/src/ports/affair-submission-repository.ts`
- `packages/domain/src/use-cases/affair-submissions.ts`
- `packages/adapters/mysql/schema/012_affair_submissions.sql`
- `packages/adapters/mysql/src/affair-submission-repository.ts`
- `apps/api/src/affair-submission-routes.ts`
- `apps/api/src/affair-routes.ts`
- `apps/api/src/server.ts`
- `packages/api-contracts/src/affairs.ts`
- `doc/affairs-php-mapping.md`

No PHP code, production database, server runtime behavior, or CI configuration
was modified by this work.

## Existing C-wave note is not enough

`doc/affairs-php-mapping.md` already contains a C-wave implementation addendum,
so the broad premise that submissions had no PHP mapping at all is stale.
However, that addendum does not perform #80's A-positive, A-reverse and numeric
formula audit. More importantly, it describes the server endpoint as a
"tenant-authenticated management API" without proving a management permission
boundary.

The mechanism #80 is meant to check therefore still exists: the implementation
was compared to PHP for storage/state behavior, but its caller authorization,
admin reporting surface and exact aggregate semantics had not been traced
end-to-end. This document is the focused parity audit for that missing layer.

## Field mapping

### Submission row

| PHP              | server          | notes                                                                                                              |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`             | `id`            | integer in PHP, opaque string/UUID on server                                                                       |
| `affair_id`      | `affairId`      | same business parent                                                                                               |
| `collection_id`  | `collectionId`  | same collection parent                                                                                             |
| `company_id`     | `tenantId`      | server uses opaque tenant identity instead of PHP company integer                                                  |
| `submitter_type` | `submitterType` | `school \| city`                                                                                                   |
| `school_id`      | `schoolId`      | nullable; server enforces owner XOR                                                                                |
| `city_id`        | `cityId`        | nullable; server enforces owner XOR                                                                                |
| `account_type`   | `accountType`   | PHP schema allows `SC/SD/SE/EDU`; actual fill paths use `SC` for school submissions and `EDU` for city submissions |
| `status`         | `status`        | `draft \| submitted \| returned`                                                                                   |
| `return_reason`  | `returnReason`  | nullable, max 500 on server                                                                                        |
| `returned_at`    | `returnedAt`    | nullable timestamp                                                                                                 |
| `submitted_at`   | `submittedAt`   | nullable timestamp                                                                                                 |
| `created_at`     | `createdAt`     | timestamp                                                                                                          |
| `updated_at`     | `updatedAt`     | timestamp                                                                                                          |
| —                | `version`       | server-only optimistic concurrency token                                                                           |

The apparent `SD/SE` account-type gap is **not** a defect. PHP's school
dashboard may be entered by `SC`, `SD` or `SE`, but the actual collection,
save and submit handlers explicitly require `account_type === 'SC'`. City
submission paths always use `EDU`. Server's `EnsureAffairSubmissionSchema` and
submit repository therefore match the effective PHP write behavior when they
use `SC` for school submissions and `EDU` for city submissions.

### Form values

| PHP             | server                      | notes                                                            |
| --------------- | --------------------------- | ---------------------------------------------------------------- |
| `submission_id` | parent detail `id`          | server carries the parent id outside each form field value       |
| `field_id`      | `fieldId`                   | same bound-field identity                                        |
| `value`         | `value`                     | string payload                                                   |
| child-row `id`  | not exposed for form values | internal persistence identity is not part of the server form DTO |

PHP `ExamAffairSubmissionData::batchSave()` upserts only the field IDs supplied
and leaves omitted stored fields in place. Server does the same partial form
merge. On final submit, server validates the merged saved + incoming field set,
matching PHP's ability to submit when an already-saved required value is not
re-sent in the final request.

Server is deliberately stricter for field identity. The PHP data model itself
will upsert whatever `field_id` the caller passes; normal UI callers are built
from the collection bindings. Server rejects an unbound/cross-tenant field ID
in both the use case and MySQL repository. This is a fail-closed rejection, not
a silent drop, so it is not an A-positive data-loss defect.

### Repeated Excel rows

| PHP             | server                                  | notes                                         |
| --------------- | --------------------------------------- | --------------------------------------------- |
| `submission_id` | parent detail `id` / row `submissionId` | same parent identity                          |
| `row_data` JSON | `values` record                         | field-id -> string map                        |
| `sort_order`    | `sortOrder`                             | preserves row order                           |
| `created_at`    | `createdAt`                             | row creation timestamp                        |
| row `id`        | `id`                                    | persistence identity exposed on server detail |

Both implementations replace the entire repeated-row set on save: delete old
rows, then insert the incoming rows in order. Server additionally validates
every dynamic row key against the current collection bindings.

## A positive — PHP data compared with the server whitelist

The positive-direction question is: **can PHP read or persist a value that the
server contract silently omits?**

### Persistent business state

| PHP source value          | Server contract              | Result                                                             |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `affair_id`               | `affairId`                   | present                                                            |
| `collection_id`           | `collectionId`               | present                                                            |
| `company_id`              | `tenantId`                   | semantic tenant equivalent present                                 |
| `submitter_type`          | `submitterType`              | present                                                            |
| `school_id`               | `schoolId`                   | present                                                            |
| `city_id`                 | `cityId`                     | present                                                            |
| `account_type`            | `accountType`                | present                                                            |
| `status`                  | `status`                     | present                                                            |
| `return_reason`           | `returnReason`               | present                                                            |
| `returned_at`             | `returnedAt`                 | present                                                            |
| `submitted_at`            | `submittedAt`                | present                                                            |
| `created_at`              | `createdAt`                  | present                                                            |
| `updated_at`              | `updatedAt`                  | present                                                            |
| form `field_id` + `value` | `fields[].fieldId` + `value` | present                                                            |
| Excel `row_data`          | `rows[].values`              | present                                                            |
| Excel `sort_order`        | `rows[].sortOrder`           | present on reads; order is derived from request position on writes |

**Result: no silent omission was found in the persisted submission business
state.** The server either represents the field or, for invalid/unbound dynamic
field IDs, rejects the request instead of accepting and dropping data.

### PHP joined display fields

`ExamAffairSubmission::getByCollection()` also joins display metadata that is
not embedded in `AffairSubmissionSchema`:

| PHP joined field | Submission DTO | Server source              | Result                           |
| ---------------- | -------------- | -------------------------- | -------------------------------- |
| `school_name`    | absent         | `AffairSchool.schoolName`  | separately retrievable, not lost |
| `school_code`    | absent         | `AffairSchool.schoolCode`  | separately retrievable, not lost |
| `school_city`    | absent         | `AffairSchool.city`        | separately retrievable, not lost |
| `school_level`   | absent         | `AffairSchool.schoolLevel` | separately retrievable, not lost |
| `city_name`      | absent         | `AffairCity.cityName`      | separately retrievable, not lost |

This is a composition/API-shape difference. PHP builds one backend table row
with joins; server exposes normalized affair-school/city resources. It does not
by itself lose the underlying data, although it leaves the PHP backend table
composition to a client or future aggregate endpoint.

## A reverse — fields PHP can query but does not present

The reverse question is: **does PHP deliberately keep a queryable value out of
the user-facing result while server returns it?**

PHP's management query selects `sub.*`, but
`affairCollectionDataView.php` renders only the submitter label, status,
return reason, submit/return times and bound payload values. The server
submission DTO is broader:

| Value selected by PHP       | PHP management view       | Server DTO             | Classification                                             |
| --------------------------- | ------------------------- | ---------------------- | ---------------------------------------------------------- |
| `company_id`                | not rendered              | `tenantId` returned    | exposure difference; no PHP source comment marks it secret |
| `account_type`              | not rendered              | `accountType` returned | exposure difference; no PHP source comment marks it secret |
| raw `school_id` / `city_id` | label is rendered instead | ids returned           | normalized API identity, not proven confidential           |
| `created_at`                | not rendered              | `createdAt` returned   | metadata exposure difference                               |
| `updated_at`                | not rendered              | `updatedAt` returned   | metadata exposure difference                               |

No field-level PHP redaction rule analogous to the receipt PII whitelist was
found for these values, so the table above is **not** classified as a secret
field leak on its own.

The confirmed leak is instead at the authorization boundary: server can return
the entire submission detail, including payload values, to a caller that PHP
would never authorize for that submission. That is documented separately below
because it is stronger than any individual metadata-field difference.

For exports, PHP has two different output whitelists:

- form export emits submitter columns, `status`, `submitted_at` and bound fields;
- Excel export queries `status`, `submitted_at`, `submitter_type` and
  `school_level` but does not emit those values into the workbook rows.

Server currently has no submission-export endpoint, so there is no server
export whitelist to compare in the reverse direction.

## Confirmed authorization parity defect

**Severity: data exposure and cross-owner mutation inside one tenant.**

PHP has three distinct caller boundaries:

1. Backend collection-data list/export/return/delete/batch-return requires the
   company's `exam_affairs` permission.
2. School collection/save/submit resolves the school from the logged-in affair
   account and explicitly rejects non-`SC` accounts for form/Excel filling.
3. City collection/save/submit resolves the city from the logged-in city
   account and always writes `EDU`.

The current server route does not preserve those boundaries:

- `affair-submission-routes.ts` only authenticates a bearer identity;
- `scopeFor()` narrows operations to `{ tenantId, actorUserId }`, but does not
  require an affair-management role/permission;
- `POST /affair-submissions/ensure` accepts `schoolId` or `cityId` from the
  request and only checks that the referenced owner belongs to the same tenant
  and affair/collection;
- list/get/draft/submit/return/delete and batch-return do not compare the caller
  with the submission's school/city owner;
- `server.ts` mounts these routes directly with the generic authentication
  service and no additional management/owner guard.

Therefore, **under the authorization contract visible in this repository**, an
authenticated identity in the same tenant can address submission records that
PHP would restrict to an `exam_affairs` manager or to the logged-in school/city
owner. Depending on the endpoint, that identity can list/read payloads, create
an owner submission for another same-tenant school/city, save/submit it, return
it, or delete it when the required id/version is known.

This is a confirmed parity defect, not merely a missing convenience endpoint.
#80 deliberately does **not** fix it; a follow-up must define and test the server
role/owner authorization oracle before changing routes. An external proxy or
gateway not represented in this repository could reduce the deployed exposure,
but it is not part of the server API contract audited here.

This also corrects the older C-wave wording: calling the route a
"tenant-authenticated management API" describes intended use, not an enforced
management permission.

## Numeric semantics

#80 specifically requires formulas, not names. The PHP formulas below come from
the actual model SQL.

### Collection status cards

For a collection `C`, PHP `getCollectionStats(C)` computes:

```text
total     = COUNT(submission WHERE collection_id = C)
submitted = COUNT(submission WHERE collection_id = C AND status = 'submitted')
draft     = COUNT(submission WHERE collection_id = C AND status = 'draft')
returned  = COUNT(submission WHERE collection_id = C AND status = 'returned')
```

`total` therefore includes draft + submitted + returned rows. Returned rows are
not treated as submitted.

Server has **no corresponding aggregate endpoint or repository method**.
`GET /affair-submissions` is cursor-paged and returns no total count. A client
could scan every page and count statuses, but that is not the same aggregate
contract. This is missing PHP behavior, not a case where both sides currently
return the same named number with a different formula.

### Backend filtered-list total

PHP `getByCollection()` returns `total` as:

```text
COUNT(submission
  WHERE collection_id = C
    AND optional status filter
    AND optional school-city filter
    AND optional keyword match over school_name / school_code / city_name)
```

Pagination is then derived from that filtered total. Server list supports
`collectionId`, `status` and `submitterType`, but not PHP's city/keyword filters
and returns only `nextCursor`; it has no filtered `total` number.

### City dashboard completion

For affair `A` and city `X`, PHP `getCityStats(A, X)` computes:

```text
total_schools = COUNT(active school
  WHERE affair_id = A AND city = X)

required_collections = COUNT(active collection
  WHERE affair_id = A
    AND target = 'school'
    AND type != 'receipt')

submitted_schools = COUNT(active school S in A/X
  WHERE COUNT(submission for S
    WHERE status = 'submitted'
      AND collection_id is one of required_collections)
    = required_collections)
```

If there are no required collections or no active schools,
`submitted_schools` is `0`. A draft or returned submission does **not** satisfy
a required collection; only `status='submitted'` counts.

Server exposes the underlying schools, collections and submissions but has no
first-class city completion statistic. Again, this is missing behavior rather
than a same-name/different-formula result.

### Batch-return counters

For valid positive PHP IDs and valid server `(id, version)` items, both sides
use the same business partition: an in-scope, currently `submitted` record that
successfully returns increments `returned`; an absent or non-submitted record
increments `skipped`.

The edge domains differ:

- PHP silently ignores an input ID `<= 0` without incrementing either counter;
- server schema rejects malformed/empty IDs before the use case runs;
- server optimistic-version conflicts are counted as `skipped` by its batch
  service;
- PHP has no version token, and a per-item update exception increments
  `skipped`.

No same-input numeric mismatch was found for the normal valid-item path. The
server adds concurrency semantics that PHP does not have.

## PHP behavior not implemented in this issue

### Backend city and keyword filtering

PHP's collection-data page can filter by status, school city and keyword. The
keyword searches school name, school code and city submitter name. Server list
only supports status and submitter type in addition to collection/cursor/limit.

### Backend joined display rows

PHP returns school/city names and school code/level in the same list query.
Server keeps those identities in separate affair-school/city resources. A
caller must join them itself; there is no PHP-shaped aggregate response.

### Collection status statistics and filtered totals

PHP directly returns the four collection status counts and a filtered list
total. Server has neither aggregate contract. The exact formulas are recorded
above so a future implementation cannot accidentally count returned rows as
submitted or change the denominator.

### City dashboard completion statistics

PHP's `total_schools` / `submitted_schools` calculation is a real product
semantic: a school is complete only when every active, school-target,
non-receipt collection has a `submitted` submission. Server has the primitives
but no equivalent aggregate result.

### XLSX export

PHP implements form and Excel workbook export for the backend collection-data
page. Server has no affair-submission export endpoint.

One PHP source comment says the export fetches "all submitted" records, but the
actual export SQL has **no `status='submitted'` predicate**. It exports rows from
all statuses for that collection. The SQL behavior, not the stale comment, is
the truth source for any future server export.

The two PHP workbook shapes also differ: form export includes status and submit
time; Excel export does not emit those two columns even though its query reads
them.

### Batch deletion

PHP backend deletion accepts multiple submission IDs for one collection,
verifies company + collection scope, hard-deletes the confirmed rows and returns
`deleted = affected row count`. Server exposes only single-submission DELETE
with an optimistic `version`; no batch-delete/count endpoint exists.

### School/city composed dashboards

PHP composes collection status maps and city-under-school progress in dedicated
school/city dashboards. Server exposes lower-level affairs, schools,
collections and submissions, but does not reproduce those composed dashboard
responses.

### PHP role/owner authorization

This item is not merely deferred UI composition. It is the confirmed security
parity defect described above. Future implementation must distinguish backend
`exam_affairs` management operations from school/city self-service and bind the
self-service identity to its actual school/city instead of accepting an
arbitrary same-tenant owner id from the request.

## Other deliberate server deviations

### Optimistic concurrency

Server adds `version` to mutable submissions and requires it for save, submit,
return and delete. PHP has no equivalent concurrency token. Batch-return treats
version conflicts as skipped items.

### Tenant-qualified referential integrity

Server stores `tenant_id` on the submission and child tables and uses composite
foreign keys/checks to reject cross-tenant parents and invalid owner shapes.
PHP uses company-scoped application checks plus its original foreign keys.

### Parent delete constraints

PHP DDL cascades affair/collection/school/city parent deletes to submissions.
Server migration 012 uses `RESTRICT` on those parent relationships and relies on
the explicit affair deletion rules documented separately in
`doc/affair-delete-php-mapping.md`. Child form values/rows still cascade when a
submission itself is deliberately deleted.

### Unbound field rejection

PHP model-level `batchSave()` methods do not independently verify that every
field ID/key is currently bound; normal UI construction supplies bound fields.
Server explicitly rejects unbound or cross-tenant field IDs. This is stricter
fail-closed validation and does not silently discard the value.

## What could not be verified here

- This was a static source-contract audit; no production PHP database was read
  or modified.
- No external reverse proxy/gateway authorization rule was found in the server
  repository. If deployment infrastructure outside this repository imposes an
  additional affair-management/owner policy, that mitigation is outside the
  API contract audited here.
- Per owner division of responsibility, CI check/log reading is not part of
  this handoff. The branch is delivered after the documentation change is
  pushed; no CI result is claimed here.
- No affair-submission implementation defect is repaired in #80. In particular,
  the confirmed authorization boundary gap is documented for follow-up rather
  than silently widened into this documentation-only work order.
