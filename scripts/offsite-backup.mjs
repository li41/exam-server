#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_APP_ENV_FILE,
  DEFAULT_R2_ENV_FILE,
  DEFAULT_RETENTION_COUNT,
  applyRetention,
  createBackupArchive,
  createR2Client,
  loadBackupAppConfig,
  loadR2Config,
  objectKeyForBackup,
} from "./offsite-r2.mjs";

const parseArgs = (argv) => {
  const options = {
    dryRun: false,
    appEnvFile: DEFAULT_APP_ENV_FILE,
    r2EnvFile: DEFAULT_R2_ENV_FILE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--app-env" && argv[index + 1]) {
      options.appEnvFile = argv[++index];
    } else if (arg === "--r2-env" && argv[index + 1]) {
      options.r2EnvFile = argv[++index];
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
};

export const runOffsiteBackup = async ({
  dryRun = false,
  appEnvFile = DEFAULT_APP_ENV_FILE,
  r2EnvFile = DEFAULT_R2_ENV_FILE,
  keepCount = DEFAULT_RETENTION_COUNT,
  client: clientOverride,
  createBackupImpl,
  output = console.log,
}) => {
  const r2Config = await loadR2Config(r2EnvFile);
  const client = clientOverride ?? createR2Client(r2Config);

  if (dryRun) {
    return applyRetention({
      client,
      prefix: r2Config.prefix,
      keepCount,
      dryRun: true,
      output,
    });
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
      r2Config.prefix,
      backup.backupDirectory,
    );
    await client.putObject(objectKey, archive.archivePath);
    output(`已上傳 ${objectKey} sha256=${archive.sha256}`);
    const retention = await applyRetention({
      client,
      prefix: r2Config.prefix,
      keepCount,
      dryRun: false,
      output,
    });
    return {
      backupDirectory: backup.backupDirectory,
      objectKey,
      retention,
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const result = await runOffsiteBackup(options);
  if (options.dryRun) {
    console.log("dry-run: 未建立本機備份、未上傳、未刪除任何 R2 物件");
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
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
