import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertDisjointPaths,
  assertDirectory,
  collectStorageFiles,
  copyStorageSnapshot,
  sha256File,
  withMySqlOptionFile,
  writeJsonAtomic,
  runCommand,
} from "./backup-common.mjs";
import {
  deploymentIdentityFromValues,
  normalizeDeploymentIdentity,
} from "./deployment-identity.mjs";

const requireEnvironment = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const backupName = () =>
  `backup-${new Date().toISOString().replace(/[.:]/g, "-")}-${randomUUID()}`;

export const createBackup = async ({
  mysqlUrl,
  storageRoot,
  backupRoot,
  deploymentIdentity,
  mysqldumpBin = "mysqldump",
  now = new Date(),
}) => {
  const identity = normalizeDeploymentIdentity(deploymentIdentity);
  const sourceStorageRoot = resolve(storageRoot);
  const destinationRoot = resolve(backupRoot);
  assertDisjointPaths(sourceStorageRoot, destinationRoot);
  await assertDirectory(sourceStorageRoot, "FILE_STORAGE_ROOT");
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });

  const backupDirectory = join(destinationRoot, backupName());
  const dumpPath = join(backupDirectory, "mysql.sql");
  const manifestPath = join(backupDirectory, "manifest.json");
  await mkdir(backupDirectory, { recursive: false, mode: 0o700 });

  try {
    await withMySqlOptionFile(mysqlUrl, async (optionFile, connection) => {
      await runCommand(mysqldumpBin, [
        `--defaults-extra-file=${optionFile}`,
        "--single-transaction",
        "--routines",
        "--events",
        "--triggers",
        "--hex-blob",
        "--no-tablespaces",
        "--set-gtid-purged=OFF",
        `--result-file=${dumpPath}`,
        connection.database,
      ]);
    });

    await copyStorageSnapshot(sourceStorageRoot, backupDirectory);
    const storageFiles = await collectStorageFiles(backupDirectory);
    const manifest = {
      version: 1,
      createdAt: now.toISOString(),
      deployment: identity,
      database: {
        dump: "mysql.sql",
        sha256: await sha256File(dumpPath),
      },
      storage: {
        directories: ["files", "metadata"],
        files: storageFiles,
      },
      redis: {
        included: false,
        reason:
          "Redis contains revocable sessions and TTL state, not durable data.",
      },
    };
    await writeJsonAtomic(manifestPath, manifest);
    return {
      backupDirectory,
      manifestPath,
      fileCount: storageFiles.length,
      deployment: identity,
    };
  } catch (error) {
    await rm(backupDirectory, { recursive: true, force: true });
    throw error;
  }
};

const main = async () => {
  const result = await createBackup({
    mysqlUrl: requireEnvironment("MYSQL_URL"),
    storageRoot: requireEnvironment("FILE_STORAGE_ROOT"),
    backupRoot: requireEnvironment("BACKUP_ROOT"),
    deploymentIdentity: deploymentIdentityFromValues(process.env),
    mysqldumpBin: process.env.MYSQLDUMP_BIN ?? "mysqldump",
  });
  console.log(JSON.stringify(result, null, 2));
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
