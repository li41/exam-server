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
  DEFAULT_R2_RESTORE_ENV_FILE,
  createBackupArchive,
  createR2ReadClient,
  createWriteOnlyUploadClient,
  loadUploadConfig,
  parseDataEnv,
} from "./offsite-r2.mjs";
import { restoreOffsiteBackup } from "./offsite-restore.mjs";
import workerModule, {
  handleRequest,
} from "../deploy/cloudflare/offsite-backup-worker.mjs";

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

const writeUploadEnv = async (root, content) => {
  const path = join(root, "upload.env");
  await writeFile(
    path,
    content ??
      "OFFSITE_UPLOAD_URL=https://backup.example.test/upload\nOFFSITE_UPLOAD_TOKEN=test-upload-secret\nR2_PREFIX=server-foundation/backups\n",
    { mode: 0o600 },
  );
  return path;
};

const writeReadEnv = async (root) => {
  const path = join(root, "read.env");
  await writeFile(
    path,
    "R2_ACCOUNT_ID=abc123\nR2_BUCKET=test-bucket\nR2_ACCESS_KEY_ID=read-only-access\nR2_SECRET_ACCESS_KEY=read-only-secret\nR2_PREFIX=server-foundation/backups\n",
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
    "OFFSITE_UPLOAD_TOKEN=$(touch /tmp/should-not-run)\nR2_PREFIX=a=b\n",
  );
  assert.equal(values.OFFSITE_UPLOAD_TOKEN, "$(touch /tmp/should-not-run)");
  assert.equal(values.R2_PREFIX, "a=b");
});

test("steady-state upload config rejects legacy R2 credentials", async () => {
  const root = await temporaryRoot("offsite-write-only-config-");
  const legacy = await writeUploadEnv(
    root,
    "R2_ACCOUNT_ID=abc123\nR2_BUCKET=test-bucket\nR2_ACCESS_KEY_ID=old-write-key\nR2_SECRET_ACCESS_KEY=old-write-secret\n",
  );
  await assert.rejects(
    loadUploadConfig(legacy),
    /unsupported upload credential key/u,
  );

  const insecure = await writeUploadEnv(
    root,
    "OFFSITE_UPLOAD_URL=http://backup.example.test/upload\nOFFSITE_UPLOAD_TOKEN=x\n",
  );
  await assert.rejects(loadUploadConfig(insecure), /must use https/u);
});

test("write-only client uses multipart and never puts the upload secret in URLs", async () => {
  const root = await temporaryRoot("offsite-write-only-client-");
  const filePath = join(root, "backup.tar.gz");
  await writeFile(filePath, "abcdefghijklmnopqrstuvwxyz");
  const calls = [];
  const client = createWriteOnlyUploadClient(
    {
      uploadUrl: new URL("https://backup.example.test/upload"),
      uploadToken: "secret-must-stay-in-header",
      prefix: "server-foundation/backups",
      partSizeBytes: 8,
    },
    {
      fetchImpl: async (url, init) => {
        const parsed = new URL(url);
        calls.push({ url: parsed.href, init });
        const action = parsed.searchParams.get("action");
        if (action === "mpu-create") {
          return Response.json({
            key: parsed.searchParams.get("key"),
            uploadId: "upload-1",
          });
        }
        if (action === "mpu-uploadpart") {
          const partNumber = Number(parsed.searchParams.get("partNumber"));
          return Response.json({ partNumber, etag: `etag-${partNumber}` });
        }
        if (action === "mpu-complete") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected action ${action}`);
      },
    },
  );

  const result = await client.putObject(
    "server-foundation/backups/backup-test.tar.gz",
    filePath,
  );
  assert.equal(result.partCount, 4);
  assert.equal(calls.filter((call) => call.init.method === "PUT").length, 4);
  assert.ok(
    calls.every((call) =>
      call.init.headers.authorization.endsWith("secret-must-stay-in-header"),
    ),
  );
  assert.ok(
    calls.every((call) => !call.url.includes("secret-must-stay-in-header")),
  );
});

test("Worker HTTP surface is upload-only and refuses overwrite", async () => {
  let createCalls = 0;
  const bucket = {
    head: async () => null,
    createMultipartUpload: async (key, options) => {
      createCalls += 1;
      assert.equal(options.customMetadata.sha256.length, 64);
      return { key, uploadId: "upload-1" };
    },
    resumeMultipartUpload: () => ({
      uploadPart: async (partNumber) => ({
        partNumber,
        etag: `etag-${partNumber}`,
      }),
      complete: async () => ({ httpEtag: '"done"' }),
    }),
  };
  const env = {
    BACKUP_BUCKET: bucket,
    BACKUP_PREFIX: "server-foundation/backups",
    UPLOAD_TOKEN: "worker-secret",
  };
  const base =
    "https://worker.example.test/?key=server-foundation%2Fbackups%2Fbackup-a.tar.gz";
  const auth = { authorization: "Bearer worker-secret" };

  const getResponse = await handleRequest(
    new Request(base, { headers: auth }),
    env,
  );
  assert.equal(getResponse.status, 405);
  const deleteResponse = await handleRequest(
    new Request(base, { method: "DELETE", headers: auth }),
    env,
  );
  assert.equal(deleteResponse.status, 405);

  const createResponse = await handleRequest(
    new Request(`${base}&action=mpu-create`, {
      method: "POST",
      headers: {
        ...auth,
        "x-backup-sha256": "a".repeat(64),
      },
    }),
    env,
  );
  assert.equal(createResponse.status, 200);
  assert.equal(createCalls, 1);

  const overwriteResponse = await handleRequest(
    new Request(`${base}&action=mpu-create`, {
      method: "POST",
      headers: {
        ...auth,
        "x-backup-sha256": "b".repeat(64),
      },
    }),
    {
      ...env,
      BACKUP_BUCKET: { ...bucket, head: async () => ({ key: "exists" }) },
    },
  );
  assert.equal(overwriteResponse.status, 409);
});

test("Worker exposes no scheduled retention/delete path to the host", () => {
  assert.equal(typeof workerModule.fetch, "function");
  assert.equal(workerModule.scheduled, undefined);
});

test("restore R2 client exposes read/list only", async () => {
  const requests = [];
  const client = createR2ReadClient(
    {
      accountId: "abc123",
      bucket: "test-bucket",
      accessKeyId: "read-key",
      secretAccessKey: "read-secret",
      prefix: "server-foundation/backups",
    },
    {
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>server-foundation%2Fbackups%2Fbackup-a.tar.gz</Key><LastModified>2026-08-15T01:00:00.000Z</LastModified></Contents></ListBucketResult>`,
          { status: 200 },
        );
      },
    },
  );
  const objects = await client.listObjects();
  assert.equal(objects.length, 1);
  assert.equal(client.putObject, undefined);
  assert.equal(client.deleteObject, undefined);
  assert.ok(requests.every((request) => request.init.method === "GET"));
});

test("off-site restore still downloads and extracts before restore", async () => {
  const root = await temporaryRoot("offsite-read-only-restore-");
  const backupDirectory = join(root, "backup-remote-roundtrip");
  await mkdir(join(backupDirectory, "files"), { recursive: true });
  await mkdir(join(backupDirectory, "metadata"), { recursive: true });
  await writeFile(join(backupDirectory, "manifest.json"), "{}\n");
  await writeFile(join(backupDirectory, "mysql.sql"), "fake dump\n");
  await writeFile(join(backupDirectory, "files", "sentinel.txt"), "from-r2\n");

  const { archivePath } = await createBackupArchive({
    backupDirectory,
    workRoot: join(root, "archive"),
  });
  const remoteObject = join(root, "remote.tar.gz");
  await copyFile(archivePath, remoteObject);

  const r2EnvFile = await writeReadEnv(root);
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
  assert.match(DEFAULT_R2_RESTORE_ENV_FILE, /^\/run\//u);
});

test("installer keeps upload secret separate from ephemeral read-only restore secret", async () => {
  const installer = await readFile(
    new URL("../deploy/scripts/install-offsite-backup.sh", import.meta.url),
    "utf8",
  );
  const uploadExample = await readFile(
    new URL("../deploy/offsite-backup.env.example", import.meta.url),
    "utf8",
  );
  const restoreExample = await readFile(
    new URL("../deploy/offsite-restore.env.example", import.meta.url),
    "utf8",
  );

  assert.match(installer, /R2_ACCESS_KEY_ID\|R2_SECRET_ACCESS_KEY/u);
  assert.match(installer, /disable --now "\$TIMER"/u);
  assert.match(installer, /不覆蓋/u);
  assert.match(uploadExample, /OFFSITE_UPLOAD_TOKEN=CHANGE_ME/u);
  assert.doesNotMatch(uploadExample, /R2_SECRET_ACCESS_KEY/u);
  assert.match(restoreExample, /Object Read only/u);
  assert.match(restoreExample, /R2_SECRET_ACCESS_KEY=CHANGE_ME/u);
});
