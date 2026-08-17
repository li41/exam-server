# Company members: PHP behavior mapping

Issue: `#55 WO-COMPANY-MEMBERS`

This change builds the company-member and permission data path inside `exam-server` without switching the desktop or any existing resource authorization flow away from `exam-control`. The new company-member endpoints are protected by the server's current authentication and by the member-management permission described below; no existing question/examinee/etc. route is changed to consult this table.

## Truth sources checked

| PHP source                                | Behavior carried into `exam-server`                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/db/exam_tw.sql` `company_members` | `user_id` is required; `invited_email` is nullable; `is_admin`, `permissions`, `status`, three-state `review_status`, reviewer fields, join/update timestamps are separate fields.        |
| `src/Models/CompanyMember.php`            | 13 permission keys, question permission exclusivity, admin permission map, `hasPermission()` admin shortcut and review behavior.                                                          |
| `src/Pages/Ajax/MemberActions.php`        | Member-management caller restrictions: member permission required, non-admins cannot modify admins/promote to admin, self-edit is rejected, last active+approved admin cannot be demoted. |
| `src/Pages/Ajax/Actions.php`              | `getContext()` rejects a membership when `isActive()` is false before `requirePermission()` calls `hasPermission()`.                                                                      |
| `src/Models/User.php`                     | `getMembership()` itself only looks up company+user and does not filter `review_status`; therefore there is no hidden review gate between `getContext()` and `hasPermission()`.           |

## Corrections to the original work order

1. There are **13** permission constants, not 46. The original 46 count included references to the constants.
2. PHP `company_members.user_id` is **NOT NULL**. When the invited email does not yet have a real user, current PHP first creates a pending placeholder user, writes that user's id into `company_members.user_id`, keeps `invited_email`, and later rebinds the membership on OAuth login.
3. `CompanyMember::hasPermission()` does not inspect `status`, but the AJAX caller does: `getContext()` requires an active membership first. The effective AJAX behavior is therefore `active && hasPermission(...)`.

## Field mapping

| PHP                                         | `exam-server`        | Notes                                                                                   |
| ------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| `company_id`                                | `tenant_id`          | Every repository read/write is narrowed by the authenticated tenant.                    |
| `user_id`                                   | `user_id`            | Required. MySQL write additionally verifies the user belongs to the same tenant.        |
| `invited_email`                             | `invited_email`      | Nullable; may coexist with a placeholder `user_id`.                                     |
| `is_admin`                                  | `is_admin`           | Boolean stored as `TINYINT(1)`.                                                         |
| `permissions`                               | `permissions`        | JSON, but runtime input/storage is validated as the exact 13-key contract.              |
| `status`                                    | `status`             | PHP `0/1` maps to `disabled/active`. Independent of review state.                       |
| `review_status`                             | `review_status`      | PHP `0/1/2` maps to `pending/approved/rejected`.                                        |
| `reviewed_by`, `reviewed_at`, `review_note` | same semantic fields | Generic review-state edits record the authenticated actor when no reviewer is supplied. |
| `joined_at`, `updated_at`                   | same semantic fields | MySQL stores millisecond timestamps.                                                    |
| n/a                                         | `version`            | Added for the repository's existing optimistic-concurrency convention.                  |

## Permission contract

The keys are closed, named, and compile-time represented as `Record<CompanyMemberPermission, boolean>`:

1. `questions_all`
2. `questions_own`
3. `media`
4. `exams`
5. `examinees`
6. `results`
7. `reports`
8. `settings`
9. `members`
10. `categories`
11. `logs`
12. `exam_affairs`
13. `site`

When a permissions object is supplied over the API or read from MySQL it must contain **all 13 and only these 13** keys, all booleans. An extra key or a missing key is a validation error rather than silently drifting.

PHP's exclusive group is preserved: if both `questions_all` and `questions_own` arrive as true, `questions_all` wins and `questions_own` becomes false because PHP keeps the first active key in that group.

The administrator map is also copied exactly: every permission is true except `questions_own=false`. As in PHP, `hasPermission()` returns true immediately for an administrator rather than reading the stored granular map.

## Effective access matrix copied from the PHP caller

The new member-management route intentionally separates PHP's `hasPermission()` behavior from its caller's active-membership check.

| status   | review           | admin | `members` flag | Effective member-management access                                           |
| -------- | ---------------- | ----- | -------------- | ---------------------------------------------------------------------------- |
| disabled | any              | true  | any            | **deny** — `getContext()`-equivalent active gate wins before admin shortcut. |
| active   | pending          | true  | any            | **allow** — PHP quirk: admin shortcut bypasses review.                       |
| active   | rejected         | true  | any            | **allow** — same PHP quirk.                                                  |
| active   | pending/rejected | false | true           | **deny** — non-admin `hasPermission()` requires approved review.             |
| active   | approved         | false | true           | **allow**.                                                                   |
| active   | approved         | false | false          | **deny**.                                                                    |

The active-admin/pending-or-rejected behavior is surprising, but it is the PHP behavior. This change records and copies it rather than silently fixing it.

## Write-policy parity

For the member-management API itself:

- the caller must have effective `members` permission;
- a non-admin manager cannot edit an admin or promote another member to admin;
- a caller cannot edit their own membership;
- demoting an admin requires an explicit granular permission map and is rejected if it would leave no other **active + approved** admin;
- admin records use the PHP admin permission map;
- non-admin permission input is normalized for the question exclusivity rule.

This does **not** switch question bank, examinee, file, exam, or any other existing route to company-member authorization.

## Invitation and review workflow boundary

This work order allowed invitation/review flow to be deferred. The following are deliberately **not implemented** here:

- creating the PHP-style pending placeholder user from an invited email;
- OAuth-time lookup/rebinding of `invited_email` to a real user;
- deleting the now-unreferenced placeholder user;
- email delivery or invitation lifecycle;
- a dedicated approve/reject command with audit wording matching the PHP UI.

Generic member read/write supports `invitedEmail` and the three review states so the data model can represent those states. A separate auth/invitation work order should decide how to create a safe placeholder in this repository's existing `users` schema (`password_hash`, `tenant_id`, and roles are required) and how that interacts with the future auth cutover.

## Tenant-isolation mutation table

The MySQL integration test `company-member-repository.integration.test.ts` is written as a behavioral oracle, not a source-string oracle.

| Guard                                                  | Widening mutation expected red     | Reverse mutation expected red | Behavioral assertion                                                                |
| ------------------------------------------------------ | ---------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `list`: `tenant_id = ?`                                | replace tenant predicate with true | append `AND 1=0`              | tenant A list must contain A member; tenant B list must not contain it.             |
| `get`: `id = ? AND tenant_id = ?`                      | drop/true the tenant predicate     | append `AND 1=0`              | same id is readable in A and `null` in B.                                           |
| `findByUserId`: `user_id = ? AND tenant_id = ?`        | drop/true tenant predicate         | append `AND 1=0`              | A finds its user; B does not.                                                       |
| `update`: `id = ? AND tenant_id = ? AND version = ?`   | drop/true tenant predicate         | append `AND 1=0`              | same-tenant update succeeds; B update of A's id throws not-found.                   |
| update-failure probe                                   | drop/true tenant predicate         | append `AND 1=0`              | cross-tenant failed update remains not-found rather than leaking version existence. |
| `countActiveApprovedAdmins`: `tenant_id = ?`           | drop/true tenant predicate         | append `AND 1=0`              | A count is positive; B count is zero.                                               |
| user ownership check: `users.id = ? AND tenant_id = ?` | drop/true tenant predicate         | append `AND 1=0`              | a B user cannot be inserted as an A member; same-tenant user creation succeeds.     |

### Mutation execution status in this environment

The oracles above are committed as executable MySQL integration tests. **The widening mutations and reverse `AND 1=0` mutations were not executed here**, because this environment cannot provision `pnpm` (DNS cannot resolve `registry.npmjs.org`) and has no usable MySQL service/client. They must not be reported as PASS. CI/owner execution with MySQL 8.4 is required to produce the red/green evidence.

## Local validation limits

- Full `pnpm verify`: must be attempted for delivery; if Corepack cannot provision pnpm, none of its chained substeps can be claimed as executed.
- `npx prettier --write` on changed files: must be attempted; if the package cannot be obtained, formatting is manually kept in repository style but not claimed as Prettier-verified.
- MySQL 8.4 integration tests: not runnable without pnpm and a MySQL service.
- Redis/API backing-service integration, backup/restore rehearsal, and deployment exercises are outside this work order's changes and are not substituted for the required full verify gate.
