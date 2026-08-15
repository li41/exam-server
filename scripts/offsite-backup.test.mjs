import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_RETENTION_COUNT,
  applyRetention,
  buildRetentionPlan,
  createBackupArchive,
  createR2Client,
  formatRetentionPlan,
  loadR2Config,
  parseDataEnv,
} from "./offsite-r2.mjs";
import { runOffsiteBackup } from "./offsite-backup.mjs";
import { restoreOffsiteBackup } from "./offsite-restore.mjs";

const roots = [];
const temporaryRoot = async (prefix) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

test.afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const writeR2Env = async (root, extra = "") => {
  const path = join(root, "r2.env");
  await writeFile(
    path,
    `R2_ACCOUNT_ID=abc123\nR2_BUCKET=test-bucket\nR2_ACCESS_KEY_ID=test-access\nR2_SECRET_ACCESS_KEY=test-secret\nR2_PREFIX=server-foundation/backups\n${extra}`,
    { mode: 0o600 },
  );
  return path;
};

const writeAppEnv = async (root) => {
  const path = join(root, "app.env");
  await writeFile(
    path,
    `MYSQL_URL=mysql://user:secret@127.0.0.1:3306/app\nFILE_STORAGE_ROOT=${join(root, "storage")}\nBACKUP_ROOT=${join(root, "backups")}\n`,
    { mode: 0o600 },
  );
  return path;
};

test("credential parsing treats values as data instead of shell", () => {
  const values = parseDataEnv(
    "R2_ACCOUNT_ID=abc123\nR2_SECRET_ACCESS_KEY=$(touch /tmp/should-not-run)\n",
  );
  assert.equal(values.R2_SECRET_ACCESS_KEY, "$(touch /tmp/should-not-run)");
});

test("R2 credential file rejects unknown keys and CHANGE_ME", async () => {
  const root = await temporaryRoot("offsite-config-");
  const unknown = await writeR2Env(root, "SHELL_COMMAND=echo-no\n");
  await assert.rejects(loadR2Config(unknown), /unsupported R2 credential key/u);

  await writeFile(
    unknown,
    "R2_ACCOUNT_ID=CHANGE_ME\nR2_BUCKET=test-bucket\nR2_ACCESS_KEY_ID=test\nR2_SECRET_ACCESS_KEY=test\n",
  );
  await assert.rejects(
    loadR2Config(unknown),
    /R2_ACCOUNT_ID must be configured/u,
  );
});

test("retention keeps the newest 30 backups and marks only older copies for deletion", () => {
  const objects = Array.from({ length: 32 }, (_, index) => ({
    key: `server-foundation/backups/backup-${String(index).padStart(2, "0")}.tar.gz`,
    lastModified: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
  }));
  const plan = buildRetentionPlan(objects);
  assert.equal(plan.keep.length, DEFAULT_RETENTION_COUNT);
  assert.equal(plan.delete.length, 2);
  assert.match(plan.keep[0].key, /backup-31\.tar\.gz$/u);
  assert.match(plan.delete[0].key, /backup-01\.tar\.gz$/u);
  assert.match(plan.delete[1].key, /backup-00\.tar\.gz$/u);

  const output = formatRetentionPlan(plan);
  assert.match(output, /會保留 \(30\)/u);
  assert.match(output, /會刪除 \(2\)/u);
});

test("retention is fail-closed when the remote list cannot be read", async () => {
  const deleted = [];
  const client = {
    listObjects: async () => {
      throw new Error("R2 unavailable");
    },
    deleteObject: async (key) => deleted.push(key),
  };
  await assert.rejects(
    applyRetention({
      client,
      prefix: "server-foundation/backups",
      output: () => undefined,
    }),
    /R2 unavailable/u,
  );
  assert.deepEqual(deleted, []);
});

test("off-site --dry-run lists keep/delete decisions without changing remote data", async () => {
  const root = await temporaryRoot("offsite-dry-run-");
  const r2EnvFile = await writeR2Env(root);
  const deleted = [];
  const output = [];
  const plan = await runOffsiteBackup({
    dryRun: true,
    r2EnvFile,
    keepCount: 2,
    client: {
      listObjects: async () => [
        {
          key: "server-foundation/backups/backup-new.tar.gz",
          lastModified: "2026-08-15T03:00:00.000Z",
        },
        {
          key: "server-foundation/backups/backup-middle.tar.gz",
          lastModified: "2026-08-14T03:00:00.000Z",
        },
        {
          key: "server-foundation/backups/backup-old.tar.gz",
          lastModified: "2026-08-13T03:00:00.000Z",
        },
      ],
      deleteObject: async (key) => deleted.push(key),
      putObject: async () => assert.fail("dry-run must not upload"),
    },
    output: (line) => output.push(line),
  });
  assert.equal(plan.keep.length, 2);
  assert.equal(plan.delete.length, 1);
  assert.deepEqual(deleted, []);
  assert.match(output.join("\n"), /DELETE .*backup-old\.tar\.gz/u);
});

test("R2 client signs ListObjectsV2 against the account endpoint", async () => {
  const requests = [];
  const client = createR2Client(
    {
      accountId: "abc123",
      bucket: "test-bucket",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      prefix: "server-foundation/backups",
    },
    {
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return new Response(
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>server-foundation%2Fbackups%2Fbackup-a.tar.gz</Key><LastModified>2026-08-15T01:00:00.000Z</LastModified></Contents></ListBucketResult>`,
          { status: 200 },
        );
      },
    },
  );
  const objects = await client.listObjects();
  assert.deepEqual(objects, [
    {
      key: "server-foundation/backups/backup-a.tar.gz",
      lastModified: "2026-08-15T01:00:00.000Z",
    },
  ]);
  assert.match(
    requests[0].url,
    /^https:\/\/abc123\.r2\.cloudflarestorage\.com\/test-bucket\?/u,
  );
  assert.match(requests[0].url, /list-type=2/u);
  assert.match(requests[0].init.headers.authorization, /^AWS4-HMAC-SHA256 /u);
  assert.doesNotMatch(requests[0].url, /secret-key/u);
});

test("off-site restore downloads and extracts the remote archive before restore", async () => {
  const root = await temporaryRoot("offsite-restore-");
  const backupDirectory = join(root, "backup-remote-roundtrip");
  await mkdir(join(backupDirectory, "files"), { recursive: true });
  await mkdir(join(backupDirectory, "metadata"), { recursive: true });
  await writeFile(join(backupDirectory, "manifest.json"), "{}\n");
  await writeFile(join(backupDirectory, "mysql.sql"), "fake dump\n");
  await writeFile(join(backupDirectory, "files", "sentinel.txt"), "from-r2\n");

  const archiveRoot = join(root, "archive");
  const { archivePath } = await createBackupArchive({
    backupDirectory,
    workRoot: archiveRoot,
  });
  const remoteObject = join(root, "remote.tar.gz");
  await copyFile(archivePath, remoteObject);

  const r2EnvFile = await writeR2Env(root);
  const appEnvFile = await writeAppEnv(root);
  const objectKey = "server-foundation/backups/backup-remote-roundtrip.tar.gz";
  let restoredFrom = null;
  const result = await restoreOffsiteBackup({
    objectKey,
    r2EnvFile,
    appEnvFile,
    confirmation: "YES",
    client: {
      getObjectToFile: async (key, destination) => {
        assert.equal(key, objectKey);
        await copyFile(remoteObject, destination);
      },
    },
    restoreImpl: async ({ backupDirectory: downloaded }) => {
      restoredFrom = downloaded;
      assert.equal(
        await readFile(join(downloaded, "files", "sentinel.txt"), "utf8"),
        "from-r2\n",
      );
      return {
        restoredFrom: downloaded,
        storageRoot: join(root, "storage"),
        previousStorageRoot: null,
      };
    },
  });
  assert.ok(restoredFrom);
  assert.equal(result.objectKey, objectKey);
});

test("installer preserves an existing credential file and wires the daily timer", async () => {
  const installer = await readFile(
    new URL("../deploy/scripts/install-offsite-backup.sh", import.meta.url),
    "utf8",
  );
  const timer = await readFile(
    new URL(
      "../deploy/systemd/server-foundation-offsite-backup.timer",
      import.meta.url,
    ),
    "utf8",
  );
  const example = await readFile(
    new URL("../deploy/offsite-backup.env.example", import.meta.url),
    "utf8",
  );

  assert.match(installer, /if ! sudo test -f "\$R2_ENV_FILE"; then/u);
  assert.match(installer, /install -m 0600 -o root -g root/u);
  assert.match(installer, /已存在（保留既有 credentials）/u);
  assert.match(installer, /grep -q '=CHANGE_ME\$'/u);
  assert.match(timer, /OnCalendar=\*-\*-\* 03:30:00/u);
  assert.match(timer, /RandomizedDelaySec=30m/u);
  assert.match(timer, /Persistent=true/u);
  assert.match(example, /R2_SECRET_ACCESS_KEY=CHANGE_ME/u);
});
