# Examinees PHP mapping

Issue: #48 `WO-EXAMINEES`

This document records the PHP truth source used to implement the authoritative
on-premises examinee and examinee-group model.

## Truth source read before implementation

Read-only references from `li41/exam.tw`:

- `config/db/exam_tw.sql`
- `src/Models/Examinee.php`
- `src/Models/ExamineeGroup.php`
- `src/Services/ExamineeImporter.php`
- `src/Pages/Ajax/ExamineeActions.php`

No PHP code or production database was modified by this work.

## Field mapping

### Examinee

| PHP | server | notes |
| --- | --- | --- |
| `company_id` | `tenant_id` | server tenant identity is an opaque string |
| `group_id` | `group_id` | nullable, active same-tenant group only on writes |
| `created_by` | `created_by` | authenticated actor user id |
| `code` | encrypted `code_ciphertext` + keyed `code_digest` | user-visible examinee password |
| `identifier` | `identifier` | required, active value unique per tenant |
| `name` | `name` | required, max 100 |
| `note` | `note` | nullable |
| `status` 1/0 | `enabled` / `disabled` | explicit enum |

PHP enforces both `code` and `identifier` uniqueness within one company. The
server preserves both rules for active rows and allows the same values in
another tenant.

### Examinee group

| PHP | server | notes |
| --- | --- | --- |
| `company_id` | `tenant_id` | opaque tenant identity |
| `parent_id` | `parent_id` | nullable; parent cannot be changed by PATCH |
| `name` | `name` | sibling-name uniqueness per tenant |
| `proctor_password` | encrypted `proctor_password_ciphertext` | nullable, 4-50 chars when present |
| `sort_order` | `sort_order` | non-negative |

## Two levels are a real PHP rule

The `ExamineeGroup` model comment is not the only evidence. In
`ExamineeActions::doAddExamineeGroup()`, PHP resolves the requested parent and
rejects creation if that parent itself has a `parent_id`, returning
`最多只支援兩層群組`.

Migration 009 and the repository therefore preserve root -> child only. Parent
resolution is tenant-scoped; a foreign-tenant parent and a nonexistent parent
produce the same validation result.

## Reversible credential decision

PHP stores `examinees.code` and `examinee_groups.proctor_password` as plaintext
because administrators must be able to view/print them. The server must retain
that product capability, so one-way password hashing is not sufficient.

The server uses **AES-256-GCM authenticated encryption** with a random nonce for
stored values. The master key is a 32-byte secret stored outside MySQL and
outside Git at:

`/etc/server-foundation/examinee-credential.key`

The API process reads the path from `EXAMINEE_CREDENTIAL_KEY_FILE`. The example
production setup generates the key once with:

```sh
umask 077
openssl rand -hex 32 > /etc/server-foundation/examinee-credential.key
```

The master key derives separate encryption and lookup keys. Examinee `code`
also stores a deterministic HMAC-SHA-256 lookup digest so the database can
enforce tenant-scoped password uniqueness without storing the plaintext or a
deterministic ciphertext. The digest is keyed; it is not an unkeyed password
hash.

### What this protection does and does not solve

It prevents a MySQL-only dump from directly containing readable examinee and
proctor passwords. Tampering with encrypted values is detected by GCM.

It does **not** protect these values from:

- an authenticated API caller who is authorized to read the resource;
- compromise of the running API process or its memory;
- compromise of both the MySQL data and the credential key;
- an administrator who legitimately owns the host and key.

The key must be backed up separately with protection equivalent to other
production secrets. Losing it makes stored credentials unrecoverable.

## Search deviation caused by encryption

PHP keyword search includes the plaintext `code`. The authoritative server does
not implement substring search over encrypted passwords because doing so would
require weakening the storage design (for example deterministic/reversible
search tokens with substantial disclosure).

Server list search covers name, identifier, and note. Exact password uniqueness
is still enforced through the keyed digest. This is a deliberate security
tradeoff, not an accidental parity gap.

## Group deletion behavior

PHP physically deletes a group, cascades physical deletion to child groups, and
the `examinees.group_id` foreign key uses `ON DELETE SET NULL`.

The server follows its existing soft-delete convention. Deleting a group runs
one transaction that:

1. tenant-locks the active target and validates the optimistic version;
2. identifies its active direct children (there can be no third level);
3. sets active examinees assigned to the target or those children to
   `group_id = NULL`;
4. soft-deletes the target and children.

This preserves the PHP user-visible result (affected examinees become
ungrouped) while retaining server audit/history semantics. The physical FK also
uses `ON DELETE SET NULL` as a final hard-delete safety net.

## Cross-tenant reference privacy

Every group/parent lookup is narrowed by `tenant_id` and active state. The API
does not disclose whether an unknown id belongs to another tenant. Foreign and
nonexistent ids use the same validation message.

Identifier lookup is likewise tenant-scoped, so identical identifiers in two
tenants resolve independently.

## PHP behavior not implemented in this issue

### Examinee spreadsheet import

`ExamineeImporter.php` was read and its behavior recorded: XLSX/ODS, required
姓名/代號/密碼 columns, optional group/note/status, identifier-as-upsert key,
internal duplicate checks, existing-code checks, and transactional writes.

The importer is intentionally split to a follow-up work order so this issue can
land the authoritative repository, credential protection, tenant constraints,
and CRUD surface first. The follow-up must use this repository/credential
boundary rather than bypass it.

### Proctor-password conflict checks against exams

PHP checks a group's proctor password against other assigned groups and the
exam administrator password. `exam-server` does not yet own authoritative
`exams` / `exam_assignments` data, so that conflict oracle cannot be faithfully
implemented here. The 4-50 character format and readable storage semantics are
implemented; cross-exam conflict validation remains a dependency of future exam
work.

### Delete confirmation UI

PHP asks for confirmation when group deletion would ungroup examinees. The API
implements the deletion semantics but not a browser confirmation dialog; a
client can count/filter affected examinees before issuing DELETE.

## Migration

The new schema migration is `009_examinees`.

This change only registers migration 009 in the normal runner. It does **not**
apply the migration to production. Integration tests may apply it only to an
ephemeral MySQL test database.

## What could not be verified here

- Production key provisioning/backup permissions were not changed or tested on
  the real host; only the documented configuration contract is added.
- No current server-side exam authority exists, so the PHP proctor-password
  conflict behavior cannot be validated end-to-end yet.
- The PHP importer was inspected but is intentionally not reimplemented in this
  issue; a follow-up work order owns that scope.
