# Test booklet PHP mapping

Issue #45 moves the authoritative **test booklet** model into `exam-server`. This document records the read-only PHP truth source used for the server model and the deliberate differences needed by the server architecture.

## PHP truth source

The implementation was checked against these files in `exam.tw` without modifying them:

- `config/db/exam_tw.sql`
- `src/Models/TestBooklet.php`
- `src/Pages/Manage/testBookletCreateView.php`

The PHP `test_booklets` row contains `company_id`, `created_by`, optional `subject_id`, optional `category_id`, `code`, `name`, `description`, `status`, and timestamps. `code` is required and company-unique; `name` is required; the UI allows both subject and category to be unspecified.

The decisive composition rule is in both the SQL and model:

- `test_booklet_items.item_type` is `enum('group')` and labels `group` as a **區塊**.
- `test_booklet_items.ref_id` points to `question_groups.id`.
- `TestBooklet::addItem()` rejects every item type except `group`.
- the create/edit UI only offers **新增區塊**.

Therefore an exam-server booklet is an **ordered list of `question_groups`**. It does not directly contain standalone questions or question clusters. Questions and clusters remain nested inside a group according to the existing question-group model.

## Server representation

`test_booklets` adds the server conventions already used by the question bank:

- opaque-string `tenant_id` isolation;
- optimistic `version`;
- soft deletion through `deleted_at`;
- generated `active_code` for tenant-scoped uniqueness among non-deleted rows;
- tenant-narrowed indexes.

`test_booklet_items` stores `tenant_id`, `booklet_id`, `group_id`, zero-based `position`, and timestamps. The API accepts an ordered `groupIds` array and replaces the complete membership/order in one transaction. This intentionally improves on PHP's separate add/remove/reorder mutations: one edit has one optimistic-lock boundary and cannot expose a partially reordered booklet.

## Reference integrity and tenant privacy

Every `groupId` supplied on create/update must identify an active `question_groups` row in the same tenant. Missing IDs and IDs that exist only in another tenant produce the same validation message:

```text
Test booklet groupId "<id>" does not exist.
```

This follows the #41 privacy rule: callers cannot use validation responses to discover whether another tenant owns an ID.

`categoryId` is also validated as an active same-tenant `question_categories` row and uses the same unavailable-as-not-found approach.

## `subjectId` limitation

PHP `test_booklets.subject_id` joins `exam_subjects`. `exam-server` currently has no authoritative `exam_subjects` table or API. The server therefore preserves `subjectId` as optional opaque metadata, but **does not invent a foreign key or pretend that it can validate that identifier yet**.

This is different from `question_groups.subject_id`, whose PHP source explicitly joins `question_categories` and was therefore mapped to a server question-category ID in #43.

A future work order that moves `exam_subjects` authority to the server can add validation/migration for booklet `subjectId` without changing the booklet/group composition model.

## Duplicate semantics

PHP duplication copies subject/category/description and all ordered group items, generates a new code/name, and creates the copy disabled. The server preserves those semantics while using a UUID fragment for a bounded unique copy-code suffix and resets optimistic version/timestamps for the new record.

## Existing Cloudflare booklet rows are not migrated here

Issue #45 explicitly says the two existing CF `test_booklets` rows are **not** moved in this change. This PR does not read, update, delete, or deploy anything in `exam-control`.

A later migration needs all of the following before it is safe:

1. An explicit field-by-field mapping from the CF deployment projection to this authoritative server model. CF identifiers must not be assumed to equal server IDs.
2. A tenant mapping to the server's opaque `tenant_id` value.
3. A category mapping and, if retained, an `exam_subjects`/`subjectId` mapping.
4. For every booklet item, a mapping to the authoritative same-tenant server `question_groups.id`, preserving exact order. A CF-projection group/block ID cannot be copied blindly.
5. An operator-owned migration procedure run only after migration `008_test_booklets` has been applied by the owner. This PR does not apply it.
6. Verification after migration: expected booklet count and codes, exact ordered group membership, no cross-tenant/unavailable references, and successful readback through the server API.
7. Only after authority/data verification should the separate desktop deployment work publish server booklets to CF.

Deployment behavior is deliberately outside this issue.
