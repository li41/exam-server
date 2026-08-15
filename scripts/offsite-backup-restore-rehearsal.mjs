#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadDeploymentIdentityFromEnvFile,
  mismatchedDeploymentIdentityForRehearsal,
} from "./deployment-identity.mjs";
import {
  DEFAULT_APP_ENV_FILE,
  DEFAULT_R2_RESTORE_ENV_FILE,
  DEFAULT_UPLOAD_ENV_FILE,
  createBackupArchive,
  createR2ReadClient,
  createWriteOnlyUploadClient,
  extractBackupArchive,
  loadBackupAppConfig,
  loadR2ReadConfig,
  loadUploadConfig,
  objectKeyForBackup,
} from "./offsite-r2.mjs";

const runMysqlQuery = async ({ mysqlUrl, sql, mysqlBin = "mysql" }) => {
  const { withMySqlOptionFile } = await import("./backup-common.mjs");
  return withMySqlOptionFile(
    mysqlUrl,
    async (optionFile, connection) =>
      new Promise((resolveQuery, rejectQuery) => {
        const child = spawn(
          mysqlBin,
          [
            `--defaults-extra-file=${optionFile}`,
            "--batch",
            "--skip-column-names",
            "--execute",
            sql,
            connection.database,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.once("error", rejectQuery);
        child.once("close", (code) => {
          if (code === 0) {
            resolveQuery(Buffer.concat(stdout).toString("utf8").trim());
            return;
          }
          rejectQuery(
            new Error(
              `${mysqlBin} exited with code ${code ?? "unknown"}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          );
        });
      }),
  );
};

const proveIdentityMismatchIsRejected = async ({
  restore,
  backupDirectory,
  appConfig,
  deploymentIdentity,
  mysqlBin,
}) => {
  try {
    await restore({
      backupDirectory,
      mysqlUrl: appConfig.mysqlUrl,
      storageRoot: appConfig.storageRoot,
      deploymentIdentity:
        mismatchedDeploymentIdentityForRehearsal(deploymentIdentity),
      confirmation: "YES",
      mysqlBin,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Backup deployment identity mismatch")
    ) {
      return true;
    }
    throw error;
  }
  throw new Error(
    "Off-site rehearsal expected a deployment identity mismatch to be rejected.",
  );
};

export const rehearseOffsiteBackupRestore = async ({
  confirmation,
  appEnvFile = DEFAULT_APP_ENV_FILE,
  uploadEnvFile = DEFAULT_UPLOAD_ENV_FILE,
  r2EnvFile = DEFAULT_R2_RESTORE_ENV_FILE,
  mysqlBin = "mysql",
  mysqldumpBin = "mysqldump",
  uploadClient: uploadClientOverride,
  readClient: readClientOverride,
}) => {
  if (confirmation !== "YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE") {
    throw new Error(
      "Set OFFSITE_REHEARSAL_CONFIRM=YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE. The rehearsal mutates and restores its configured database and storage root.",
    );
  }

  const appConfig = await loadBackupAppConfig(appEnvFile);
  const deploymentIdentity = await loadDeploymentIdentityFromEnvFile(appEnvFile);
  const uploadConfig = await loadUploadConfig(uploadEnvFile);
  const r2Config = await loadR2ReadConfig(r2EnvFile);
  if (uploadConfig.prefix !== r2Config.prefix) {
    throw new Error("upload and restore R2_PREFIX values must match");
  }
  const uploadClient =
    uploadClientOverride ?? createWriteOnlyUploadClient(uploadConfig);
  const readClient = readClientOverride ?? createR2ReadClient(r2Config);
  await mkdir(join(appConfig.storageRoot, "files"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(appConfig.storageRoot, "metadata"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(appConfig.backupRoot, { recursive: true, mode: 0o700 });

  const marker = randomUUID();
  const filePath = join(
    appConfig.storageRoot,
    "files",
    "offsite-rehearsal-sentinel.txt",
  );
  const metadataPath = join(
    appConfig.storageRoot,
    "metadata",
    "offsite-rehearsal-sentinel.json",
  );
  await writeFile(filePath, `${marker}\n`, { mode: 0o600 });
  await writeFile(metadataPath, `${JSON.stringify({ marker }, null, 2)}\n`, {
    mode: 0o600,
  });
  await runMysqlQuery({
    mysqlUrl: appConfig.mysqlUrl,
    mysqlBin,
    sql: `CREATE TABLE IF NOT EXISTS offsite_backup_rehearsal_marker (marker VARCHAR(64) NOT NULL PRIMARY KEY); DELETE FROM offsite_backup_rehearsal_marker; INSERT INTO offsite_backup_rehearsal_marker (marker) VALUES ('${marker}');`,
  });

  const { createBackup } = await import("./backup.mjs");
  const backup = await createBackup({
    ...appConfig,
    deploymentIdentity,
    mysqldumpBin,
  });
  const workRoot = await mkdtemp(
    join(tmpdir(), "server-foundation-offsite-rehearsal-"),
  );
  const objectKey = objectKeyForBackup(
    uploadConfig.prefix,
    backup.backupDirectory,
  );
  let previousStorageRoot = null;
  try {
    const archive = await createBackupArchive({
      backupDirectory: backup.backupDirectory,
      workRoot,
    });
    await uploadClient.putObject(objectKey, archive.archivePath);

    // Delete the local copy before recovery proof. Everything below must use R2.
    await rm(backup.backupDirectory, { recursive: true, force: true });
    const downloadedArchive = join(workRoot, "downloaded.tar.gz");
    await readClient.getObjectToFile(objectKey, downloadedArchive);
    const downloadedBackup = await extractBackupArchive({
      archivePath: downloadedArchive,
      workRoot: join(workRoot, "extracted"),
    });
    const { restoreBackup } = await import("./restore.mjs");
    const identityMismatchRejected = await proveIdentityMismatchIsRejected({
      restore: restoreBackup,
      backupDirectory: downloadedBackup,
      appConfig,
      deploymentIdentity,
      mysqlBin,
    });

    await runMysqlQuery({
      mysqlUrl: appConfig.mysqlUrl,
      mysqlBin,
      sql: "DELETE FROM offsite_backup_rehearsal_marker;",
    });
    await writeFile(filePath, "mutated-after-offsite-backup\n", {
      mode: 0o600,
    });

    const restored = await restoreBackup({
      backupDirectory: downloadedBackup,
      mysqlUrl: appConfig.mysqlUrl,
      storageRoot: appConfig.storageRoot,
      deploymentIdentity,
      confirmation: "YES",
      mysqlBin,
    });
    previousStorageRoot = restored.previousStorageRoot;

    const restoredMarker = await runMysqlQuery({
      mysqlUrl: appConfig.mysqlUrl,
      mysqlBin,
      sql: "SELECT marker FROM offsite_backup_rehearsal_marker LIMIT 1;",
    });
    const restoredFile = (await readFile(filePath, "utf8")).trim();
    if (restoredMarker !== marker || restoredFile !== marker) {
      throw new Error("Off-site backup/restore rehearsal verification failed.");
    }
    return {
      marker,
      objectKey,
      identityMismatchRejected,
      restoredDatabase: true,
      restoredStorage: true,
      restoredFromOffsite: true,
      remoteObjectRetainedForCloudflareRetention: true,
    };
  } finally {
    if (previousStorageRoot) {
      await rm(previousStorageRoot, { recursive: true, force: true });
    }
    await rm(workRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  const result = await rehearseOffsiteBackupRestore({
    confirmation: process.env.OFFSITE_REHEARSAL_CONFIRM,
    appEnvFile: process.env.OFFSITE_APP_ENV_FILE ?? DEFAULT_APP_ENV_FILE,
    uploadEnvFile:
      process.env.OFFSITE_UPLOAD_ENV_FILE ?? DEFAULT_UPLOAD_ENV_FILE,
    r2EnvFile: process.env.OFFSITE_R2_ENV_FILE ?? DEFAULT_R2_RESTORE_ENV_FILE,
    mysqlBin: process.env.MYSQL_BIN ?? "mysql",
    mysqldumpBin: process.env.MYSQLDUMP_BIN ?? "mysqldump",
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
