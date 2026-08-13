import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackup } from "./backup.mjs";
import {
  assertDisjointPaths,
  assertSafeRelativePath,
  collectStorageFiles,
  parseMySqlUrl,
  verifyStorageFiles,
} from "./backup-common.mjs";
import { restoreBackup } from "./restore.mjs";

const temporaryRoots = [];

test.afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("parses a MySQL URL without exposing credentials in the result", () => {
  assert.deepEqual(
    parseMySqlUrl("mysql://backup%40user:p%40ss@db.example:3307/app"),
    {
      host: "db.example",
      port: 3307,
      user: "backup@user",
      password: "p@ss",
      database: "app",
    },
  );
});

test("rejects unsafe backup paths and overlapping roots", () => {
  assert.throws(() => assertSafeRelativePath("../outside.txt"));
  assert.throws(() => assertSafeRelativePath("files/../outside.txt"));
  assert.throws(() =>
    assertDisjointPaths("/tmp/storage", "/tmp/storage/backups"),
  );
});

test("collects and verifies storage file checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "server-foundation-backup-test-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "files", "nested"), { recursive: true });
  await mkdir(join(root, "metadata"), { recursive: true });
  const content = Buffer.from("backup content");
  await writeFile(join(root, "files", "nested", "report.txt"), content);
  await writeFile(join(root, "metadata", "file.json"), "{}\n");

  const files = await collectStorageFiles(root);
  assert.deepEqual(
    files.map((file) => file.path),
    ["files/nested/report.txt", "metadata/file.json"],
  );
  assert.equal(
    files[0].sha256,
    createHash("sha256").update(content).digest("hex"),
  );
  await verifyStorageFiles(root, files);
  await writeFile(join(root, "files", "nested", "report.txt"), "changed");
  await assert.rejects(verifyStorageFiles(root, files));
});

test("creates and restores a backup with fake MySQL clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "server-foundation-backup-e2e-"));
  temporaryRoots.push(root);
  const storageRoot = join(root, "storage");
  const backupRoot = join(root, "backups");
  const restoredRoot = join(root, "restored");
  await mkdir(join(storageRoot, "files"), { recursive: true });
  await mkdir(join(storageRoot, "metadata"), { recursive: true });
  await writeFile(join(storageRoot, "files", "report.txt"), "restored content");
  await writeFile(join(storageRoot, "metadata", "report.json"), "{}\n");

  const dumpClient = join(root, "fake-mysqldump.mjs");
  await writeFile(
    dumpClient,
    `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const argument = process.argv.find((value) => value.startsWith("--result-file="));
if (!argument) process.exit(2);
await writeFile(argument.slice("--result-file=".length), "fake mysql dump\\n");
`,
    { mode: 0o700 },
  );
  await chmod(dumpClient, 0o700);

  const restoreMarker = join(root, "restore-marker");
  const mysqlClient = join(root, "fake-mysql.mjs");
  await writeFile(
    mysqlClient,
    `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
await writeFile(process.env.RESTORE_MARKER, Buffer.concat(chunks));
`,
    { mode: 0o700 },
  );
  await chmod(mysqlClient, 0o700);

  const backup = await createBackup({
    mysqlUrl: "mysql://backup:secret@localhost:3306/foundation",
    storageRoot,
    backupRoot,
    mysqldumpBin: dumpClient,
  });
  const manifest = JSON.parse(
    await readFile(join(backup.backupDirectory, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.storage.files.length, 2);

  const previousMarker = process.env.RESTORE_MARKER;
  process.env.RESTORE_MARKER = restoreMarker;
  try {
    const restored = await restoreBackup({
      backupDirectory: backup.backupDirectory,
      mysqlUrl: "mysql://restore:secret@localhost:3306/foundation",
      storageRoot: restoredRoot,
      confirmation: "YES",
      mysqlBin: mysqlClient,
    });
    assert.equal(restored.previousStorageRoot, null);
    assert.equal(
      await readFile(join(restoredRoot, "files", "report.txt"), "utf8"),
      "restored content",
    );
    assert.equal(await readFile(restoreMarker, "utf8"), "fake mysql dump\n");
  } finally {
    if (previousMarker === undefined) delete process.env.RESTORE_MARKER;
    else process.env.RESTORE_MARKER = previousMarker;
  }
});
