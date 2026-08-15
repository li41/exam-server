#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_APP_ENV_FILE,
  DEFAULT_UPLOAD_ENV_FILE,
  createBackupArchive,
  createWriteOnlyUploadClient,
  loadBackupAppConfig,
  loadUploadConfig,
  objectKeyForBackup,
} from "./offsite-r2.mjs";

const parseArgs = (argv) => {
  const options = {
    dryRun: false,
    appEnvFile: DEFAULT_APP_ENV_FILE,
    uploadEnvFile: DEFAULT_UPLOAD_ENV_FILE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--app-env" && argv[index + 1]) {
      options.appEnvFile = argv[++index];
    } else if (arg === "--upload-env" && argv[index + 1]) {
      options.uploadEnvFile = argv[++index];
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
};

export const runOffsiteBackup = async ({
  dryRun = false,
  appEnvFile = DEFAULT_APP_ENV_FILE,
  uploadEnvFile = DEFAULT_UPLOAD_ENV_FILE,
  client: clientOverride,
  createBackupImpl,
  output = console.log,
}) => {
  const uploadConfig = await loadUploadConfig(uploadEnvFile);
  const client = clientOverride ?? createWriteOnlyUploadClient(uploadConfig);

  if (dryRun) {
    await client.probe();
    output(
      "write-only dry-run: upload endpoint/auth ok; no local backup, R2 list, read, delete, or upload was performed",
    );
    return { dryRun: true, remoteMutation: false };
  }

  const appConfig = await loadBackupAppConfig(appEnvFile);
  const backupFactory =
    createBackupImpl ?? (await import("./backup.mjs")).createBackup;
  const backup = await backupFactory(appConfig);
  const workRoot = await mkdtemp(join(tmpdir(), "server-foundation-offsite-"));
  try {
    const archive = await createBackupArchive({
      backupDirectory: backup.backupDirectory,
      workRoot,
    });
    const objectKey = objectKeyForBackup(
      uploadConfig.prefix,
      backup.backupDirectory,
    );
    const uploaded = await client.putObject(objectKey, archive.archivePath);
    output(
      `已上傳 ${objectKey} sha256=${archive.sha256} parts=${uploaded.partCount}`,
    );
    output(
      "retention 由 R2 Object Lifecycle 執行；院內主機不具 R2 delete capability",
    );
    return {
      backupDirectory: backup.backupDirectory,
      objectKey,
      sha256: archive.sha256,
      partCount: uploaded.partCount,
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const result = await runOffsiteBackup(options);
  console.log(JSON.stringify(result, null, 2));
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
