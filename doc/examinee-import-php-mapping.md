# Examinee spreadsheet import — PHP mapping

Truth source read before implementation:

- `exam.tw/src/Services/ExamineeImporter.php`
- `exam.tw/src/Models/ExamineeGroup.php`
- `exam.tw/src/Pages/Ajax/ExamineeActions.php`

## Preserved behavior

The server accepts `.xlsx` and `.ods` up to 10 MB and reads the first worksheet, matching PHP. Required headings are `姓名`, `代號`, and `密碼`; optional headings are `群組`, `備註`, and `狀態`. Blank rows are ignored. `identifier` is the tenant-local upsert key: an active matching identifier is updated, otherwise a new examinee is created.

PHP treats only `停用` and `0` as disabled; every other status cell, including blank or unfamiliar text, becomes enabled. The server intentionally preserves that rule rather than inventing a stricter status vocabulary for spreadsheet imports.

Group lookup is built only from active groups in the authenticated tenant. As in PHP `buildNameMap()`, imports accept a direct group name and `父群組/子群組`. A group that exists only in another tenant is therefore indistinguishable from a nonexistent group to the importer.

## Security boundary retained from #48

Spreadsheet import does not have a parallel SQL/plaintext write path. The parsed batch is passed to `ExamineeRepository.importExaminees()`. The MySQL implementation performs reference/password preflight and every insert/update in one transaction and uses the same #48 `ExamineeCredentialProtector` for AES-256-GCM ciphertext plus keyed password digest.

The import repository locks the authenticated tenant's active examinees before conflict checking. An existing password is allowed only when it belongs to the same identifier being updated. This also preserves PHP's conservative behavior: a password currently owned by another row remains a conflict even if that other row also appears in the same upload and would have changed its password later in the batch.

No production credential key is created or changed by this work. The #48 threat model remains unchanged.

## Deliberate presentation improvement

PHP returns a flat array of human-readable strings. The server keeps the same validation meaning but returns structured errors with `sheet`, `row`, `identifier`, and `message`, so the desktop client can point to the exact failing spreadsheet row.

## Transaction semantics

All parser errors are collected before repository mutation. Repository-level conflicts and group-reference failures are also collected before any write. If either layer reports an error, `imported` and `updated` are both zero and no partial batch is retained.

## Out of scope

There is no schema migration for this feature; migration 009 remains the examinee authority. This work does not deploy migration 009, provision production credential keys, or modify `exam-control`, `exam-runtime`, `exam-admin-desktop`, or `exam.tw`.
