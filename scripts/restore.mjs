import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertDisjointPaths,
  assertDirectory,
  copyStorageSnapshot,
  pathExists,
  readJson,
  resolveBackupPath,
  runCommand,
  sha256File,
  validateManifest,
  verifyStorageFiles,
  withMySqlOptionFile,
} from "./backup-common.mjs";
import {
  RESTORE_DEPLOYMENT_OVERRIDE_ENV,
  assertRestoreDeploymentIdentity,
  deploymentIdentityFromValues,
} from "./deployment-identity.mjs";

const requireEnvironment = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const restoreSuffix = () =>
  `.before-restore-${new Date().toISOString().replace(/[.:]/g, "-")}-${randomUUID()}`;

const replaceStorageRoot = async (stagingRoot, storageRoot) => {
  const targetRoot = resolve(storageRoot);
  const parent = dirname(targetRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const previousRoot = `${targetRoot}${restoreSuffix()}`;
  const hadPreviousRoot = await pathExists(targetRoot);
  if (hadPreviousRoot) await rename(targetRoot, previousRoot);
  try {
    await rename(stagingRoot, targetRoot);
  } catch (error) {
    if (hadPreviousRoot && !(await pathExists(targetRoot))) {
      await rename(previousRoot, targetRoot).catch(() => undefined);
    }
    throw error;
  }
  return hadPreviousRoot ? previousRoot : null;
};

export const restoreBackup = async ({
  backupDirectory,
  mysqlUrl,
  storageRoot,
  deploymentIdentity,
  identityOverrideConfirmation,
  confirmation,
  mysqlBin = "mysql",
}) => {
  if (confirmation !== "YES") {
    throw new Error("Set RESTORE_CONFIRM=YES to run a destructive restore.");
  }

  const sourceRoot = resolve(backupDirectory);
  const targetStorageRoot = resolve(storageRoot);
  assertDisjointPaths(sourceRoot, targetStorageRoot);
  await assertDirectory(sourceRoot, "BACKUP_DIR");
  if (await pathExists(targetStorageRoot)) {
    await assertDirectory(targetStorageRoot, "FILE_STORAGE_ROOT");
  }
  const manifest = await readJson(join(sourceRoot, "manifest.json"));
  validateManifest(manifest);
  const identityCheck = assertRestoreDeploymentIdentity({
    manifest,
    currentIdentity: deploymentIdentity,
    overrideConfirmation: identityOverrideConfirmation,
  });

  const dumpPath = resolveBackupPath(sourceRoot, manifest.database.dump);
  if (!(await pathExists(dumpPath))) {
    throw new Error(`MySQL dump is missing: ${dumpPath}`);
  }
  if ((await sha256File(dumpPath)) !== manifest.database.sha256) {
    throw new Error("MySQL dump checksum does not match the manifest.");
  }
  await verifyStorageFiles(sourceRoot, manifest.storage.files);

  const stagingRoot = `${targetStorageRoot}.restore-${randomUUID()}`;
  let stagingExists = false;
  try {
    await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
    stagingExists = true;
    await copyStorageSnapshot(sourceRoot, stagingRoot);
    await verifyStorageFiles(stagingRoot, manifest.storage.files);

    await withMySqlOptionFile(mysqlUrl, async (optionFile, connection) => {
      await runCommand(
        mysqlBin,
        [`--defaults-extra-file=${optionFile}`, connection.database],
        { stdinPath: dumpPath },
      );
    });

    const previousStorageRoot = await replaceStorageRoot(
      stagingRoot,
      targetStorageRoot,
    );
    stagingExists = false;
    return {
      restoredFrom: sourceRoot,
      storageRoot: targetStorageRoot,
      previousStorageRoot,
      backupDeployment: identityCheck.backupIdentity,
      deploymentIdentityOverrideUsed: identityCheck.overrideUsed,
      legacyDeploymentIdentityMissing: identityCheck.legacyIdentityMissing,
    };
  } catch (error) {
    if (stagingExists) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    throw error;
  }
};

const main = async () => {
  const result = await restoreBackup({
    backupDirectory: requireEnvironment("BACKUP_DIR"),
    mysqlUrl: requireEnvironment("MYSQL_URL"),
    storageRoot: requireEnvironment("FILE_STORAGE_ROOT"),
    deploymentIdentity: deploymentIdentityFromValues(process.env),
    identityOverrideConfirmation: process.env[RESTORE_DEPLOYMENT_OVERRIDE_ENV],
    confirmation: process.env.RESTORE_CONFIRM,
    mysqlBin: process.env.MYSQL_BIN ?? "mysql",
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
