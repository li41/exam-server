import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createBackup } from "./backup.mjs";
import { withMySqlOptionFile } from "./backup-common.mjs";
import {
  deploymentIdentityFromValues,
  mismatchedDeploymentIdentityForRehearsal,
} from "./deployment-identity.mjs";
import { restoreBackup } from "./restore.mjs";

const requireEnvironment = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const runMysqlQuery = async ({ mysqlUrl, sql, mysqlBin = "mysql" }) =>
  withMySqlOptionFile(
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

const proveIdentityMismatchIsRejected = async ({
  backupDirectory,
  mysqlUrl,
  storageRoot,
  deploymentIdentity,
  mysqlBin,
}) => {
  const wrongIdentity =
    mismatchedDeploymentIdentityForRehearsal(deploymentIdentity);
  try {
    await restoreBackup({
      backupDirectory,
      mysqlUrl,
      storageRoot,
      deploymentIdentity: wrongIdentity,
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
    "Backup/restore rehearsal expected a deployment identity mismatch to be rejected.",
  );
};

export const rehearseBackupRestore = async ({
  mysqlUrl,
  storageRoot,
  backupRoot,
  deploymentIdentity,
  confirmation,
  mysqlBin = "mysql",
  mysqldumpBin = "mysqldump",
}) => {
  if (confirmation !== "YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE") {
    throw new Error(
      "Set BACKUP_REHEARSAL_CONFIRM=YES_I_UNDERSTAND_THIS_IS_DESTRUCTIVE. The rehearsal mutates and restores its configured database and storage root.",
    );
  }

  const targetStorageRoot = resolve(storageRoot);
  const targetBackupRoot = resolve(backupRoot);
  await mkdir(join(targetStorageRoot, "files"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(targetStorageRoot, "metadata"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(targetBackupRoot, { recursive: true, mode: 0o700 });

  const marker = randomUUID();
  const filePath = join(targetStorageRoot, "files", "rehearsal-sentinel.txt");
  const metadataPath = join(
    targetStorageRoot,
    "metadata",
    "rehearsal-sentinel.json",
  );
  await writeFile(filePath, `${marker}\n`, { mode: 0o600 });
  await writeFile(metadataPath, `${JSON.stringify({ marker }, null, 2)}\n`, {
    mode: 0o600,
  });

  await runMysqlQuery({
    mysqlUrl,
    mysqlBin,
    sql: `CREATE TABLE IF NOT EXISTS backup_rehearsal_marker (marker VARCHAR(64) NOT NULL PRIMARY KEY); DELETE FROM backup_rehearsal_marker; INSERT INTO backup_rehearsal_marker (marker) VALUES ('${marker}');`,
  });

  const backup = await createBackup({
    mysqlUrl,
    storageRoot: targetStorageRoot,
    backupRoot: targetBackupRoot,
    deploymentIdentity,
    mysqldumpBin,
  });

  const identityMismatchRejected = await proveIdentityMismatchIsRejected({
    backupDirectory: backup.backupDirectory,
    mysqlUrl,
    storageRoot: targetStorageRoot,
    deploymentIdentity,
    mysqlBin,
  });

  await runMysqlQuery({
    mysqlUrl,
    mysqlBin,
    sql: "DELETE FROM backup_rehearsal_marker;",
  });
  await writeFile(filePath, "mutated-after-backup\n", { mode: 0o600 });

  const restored = await restoreBackup({
    backupDirectory: backup.backupDirectory,
    mysqlUrl,
    storageRoot: targetStorageRoot,
    deploymentIdentity,
    confirmation: "YES",
    mysqlBin,
  });

  const restoredMarker = await runMysqlQuery({
    mysqlUrl,
    mysqlBin,
    sql: "SELECT marker FROM backup_rehearsal_marker LIMIT 1;",
  });
  const restoredFile = (await readFile(filePath, "utf8")).trim();
  if (restoredMarker !== marker || restoredFile !== marker) {
    throw new Error("Backup/restore rehearsal verification failed.");
  }

  if (restored.previousStorageRoot) {
    await rm(restored.previousStorageRoot, { recursive: true, force: true });
  }

  return {
    marker,
    backupDirectory: backup.backupDirectory,
    identityMismatchRejected,
    restoredDatabase: true,
    restoredStorage: true,
  };
};

const main = async () => {
  const result = await rehearseBackupRestore({
    mysqlUrl: requireEnvironment("MYSQL_URL"),
    storageRoot: requireEnvironment("FILE_STORAGE_ROOT"),
    backupRoot: requireEnvironment("BACKUP_ROOT"),
    deploymentIdentity: deploymentIdentityFromValues(process.env),
    confirmation: process.env.BACKUP_REHEARSAL_CONFIRM,
    mysqlBin: process.env.MYSQL_BIN ?? "mysql",
    mysqldumpBin: process.env.MYSQLDUMP_BIN ?? "mysqldump",
  });
  console.log(JSON.stringify(result, null, 2));
};

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
