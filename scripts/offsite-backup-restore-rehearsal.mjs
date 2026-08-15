#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  DEFAULT_APP_ENV_FILE,
  DEFAULT_R2_ENV_FILE,
  createBackupArchive,
  createR2Client,
  extractBackupArchive,
  loadBackupAppConfig,
  loadR2Config,
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

export const rehearseOffsiteBackupRestore = async ({
  confirmation,
  appEnvFile = DEFAULT_APP_ENV_FILE,
  r2EnvFile = DEFAULT_R2_ENV_FILE,
  mysqlBin = "mysql",
  mysqldumpBin = "mysqldump",
  client: clientOverride,
}) => {
  if (confirmation !== "YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE") {
    throw new Error(
      "Set OFFSITE_REHEARSAL_CONFIRM=YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE. The rehearsal mutates and restores its configured database and storage root.",
    );
  }

  const appConfig = await loadBackupAppConfig(appEnvFile);
  const r2Config = await loadR2Config(r2EnvFile);
  const client = clientOverride ?? createR2Client(r2Config);
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
    mysqldumpBin,
  });
  const workRoot = await mkdtemp(
    join(tmpdir(), "server-foundation-offsite-rehearsal-"),
  );
  const objectKey = `${r2Config.prefix}/rehearsal/${basename(backup.backupDirectory)}.tar.gz`;
  let previousStorageRoot = null;
  try {
    const archive = await createBackupArchive({
      backupDirectory: backup.backupDirectory,
      workRoot,
    });
    await client.putObject(objectKey, archive.archivePath);

    // Remove the local copy before mutation. From here on, recovery can only use R2.
    await rm(backup.backupDirectory, { recursive: true, force: true });
    await runMysqlQuery({
      mysqlUrl: appConfig.mysqlUrl,
      mysqlBin,
      sql: "DELETE FROM offsite_backup_rehearsal_marker;",
    });
    await writeFile(filePath, "mutated-after-offsite-backup\n", { mode: 0o600 });

    const downloadedArchive = join(workRoot, "downloaded.tar.gz");
    await client.getObjectToFile(objectKey, downloadedArchive);
    const downloadedBackup = await extractBackupArchive({
      archivePath: downloadedArchive,
      workRoot: join(workRoot, "extracted"),
    });
    const { restoreBackup } = await import("./restore.mjs");
    const restored = await restoreBackup({
      backupDirectory: downloadedBackup,
      mysqlUrl: appConfig.mysqlUrl,
      storageRoot: appConfig.storageRoot,
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
      restoredDatabase: true,
      restoredStorage: true,
      restoredFromOffsite: true,
    };
  } finally {
    if (previousStorageRoot) {
      await rm(previousStorageRoot, { recursive: true, force: true });
    }
    await client.deleteObject(objectKey).catch(() => undefined);
    await rm(workRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  const result = await rehearseOffsiteBackupRestore({
    confirmation: process.env.OFFSITE_REHEARSAL_CONFIRM,
    appEnvFile: process.env.OFFSITE_APP_ENV_FILE ?? DEFAULT_APP_ENV_FILE,
    r2EnvFile: process.env.OFFSITE_R2_ENV_FILE ?? DEFAULT_R2_ENV_FILE,
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
