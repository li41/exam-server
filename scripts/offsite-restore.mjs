#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_APP_ENV_FILE,
  DEFAULT_R2_ENV_FILE,
  buildRetentionPlan,
  createR2Client,
  extractBackupArchive,
  loadBackupAppConfig,
  loadR2Config,
} from "./offsite-r2.mjs";

const parseArgs = (argv) => {
  const options = {
    objectKey: null,
    appEnvFile: DEFAULT_APP_ENV_FILE,
    r2EnvFile: DEFAULT_R2_ENV_FILE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--latest") options.objectKey = null;
    else if (arg === "--key" && argv[index + 1]) {
      options.objectKey = argv[++index];
    } else if (arg === "--app-env" && argv[index + 1]) {
      options.appEnvFile = argv[++index];
    } else if (arg === "--r2-env" && argv[index + 1]) {
      options.r2EnvFile = argv[++index];
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return options;
};

const assertObjectKey = (key, prefix) => {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `^${escapedPrefix}/backup-[A-Za-z0-9._-]+\\.tar\\.gz$`,
    "u",
  );
  if (!pattern.test(key))
    throw new Error(`invalid off-site backup key: ${key}`);
  return key;
};

const latestObjectKey = async (client, prefix) => {
  const objects = await client.listObjects(prefix);
  const latest = buildRetentionPlan(objects, { prefix, keepCount: 1 }).keep[0];
  if (!latest) throw new Error(`no off-site backups found under ${prefix}/`);
  return latest.key;
};

export const restoreOffsiteBackup = async ({
  objectKey = null,
  appEnvFile = DEFAULT_APP_ENV_FILE,
  r2EnvFile = DEFAULT_R2_ENV_FILE,
  confirmation,
  client: clientOverride,
  restoreImpl,
}) => {
  if (confirmation !== "YES") {
    throw new Error(
      "Set RESTORE_CONFIRM=YES to run a destructive off-site restore.",
    );
  }
  const r2Config = await loadR2Config(r2EnvFile);
  const appConfig = await loadBackupAppConfig(appEnvFile);
  const client = clientOverride ?? createR2Client(r2Config);
  const selectedKey = assertObjectKey(
    objectKey ?? (await latestObjectKey(client, r2Config.prefix)),
    r2Config.prefix,
  );
  const workRoot = await mkdtemp(
    join(tmpdir(), "server-foundation-offsite-restore-"),
  );
  try {
    const archivePath = join(workRoot, "backup.tar.gz");
    await client.getObjectToFile(selectedKey, archivePath);
    const backupDirectory = await extractBackupArchive({
      archivePath,
      workRoot: join(workRoot, "extracted"),
    });
    const restore =
      restoreImpl ?? (await import("./restore.mjs")).restoreBackup;
    const result = await restore({
      backupDirectory,
      mysqlUrl: appConfig.mysqlUrl,
      storageRoot: appConfig.storageRoot,
      confirmation: "YES",
    });
    return { ...result, objectKey: selectedKey };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const result = await restoreOffsiteBackup({
    ...options,
    confirmation: process.env.RESTORE_CONFIRM,
  });
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
