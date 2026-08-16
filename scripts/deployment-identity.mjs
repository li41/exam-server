import { readFile } from "node:fs/promises";

export const DEPLOYMENT_TENANT_UUID_KEY = "DEPLOYMENT_TENANT_UUID";
export const DEPLOYMENT_PROJECT_ID_KEY = "DEPLOYMENT_PROJECT_ID";
export const RESTORE_DEPLOYMENT_OVERRIDE_ENV =
  "RESTORE_DEPLOYMENT_OVERRIDE_CONFIRM";
export const RESTORE_DEPLOYMENT_OVERRIDE_CONFIRMATION =
  "YES_I_UNDERSTAND_THIS_BACKUP_IS_FOR_A_DIFFERENT_DEPLOYMENT";

const tenantUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const projectId = (value) => {
  if (typeof value !== "string") {
    throw new Error(`${DEPLOYMENT_PROJECT_ID_KEY} must be configured.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized === "CHANGE_ME") {
    throw new Error(`${DEPLOYMENT_PROJECT_ID_KEY} must be configured.`);
  }
  if (normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(
      `${DEPLOYMENT_PROJECT_ID_KEY} must be at most 128 printable characters.`,
    );
  }
  return normalized;
};

const tenantUuid = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!tenantUuidPattern.test(normalized)) {
    throw new Error(
      `${DEPLOYMENT_TENANT_UUID_KEY} must be an exam-control tenant_uuid UUIDv4.`,
    );
  }
  return normalized;
};

export const deploymentIdentityFromValues = (values) => ({
  tenantUuid: tenantUuid(values?.[DEPLOYMENT_TENANT_UUID_KEY]),
  projectId: projectId(values?.[DEPLOYMENT_PROJECT_ID_KEY]),
});

export const normalizeDeploymentIdentity = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deployment identity must be an object.");
  }
  return {
    tenantUuid: tenantUuid(value.tenantUuid),
    projectId: projectId(value.projectId),
  };
};

export const loadDeploymentIdentityFromEnvFile = async (path) => {
  const values = {};
  const content = await readFile(path, "utf8");
  for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (
      key !== DEPLOYMENT_TENANT_UUID_KEY &&
      key !== DEPLOYMENT_PROJECT_ID_KEY
    ) {
      continue;
    }
    if (Object.hasOwn(values, key)) {
      throw new Error(
        `Deployment identity env has duplicate ${key} at line ${index + 1}.`,
      );
    }
    values[key] = line.slice(separator + 1).trim();
  }
  return deploymentIdentityFromValues(values);
};

export const deploymentIdentityLabel = (identity) => {
  const normalized = normalizeDeploymentIdentity(identity);
  return `tenant_uuid=${JSON.stringify(normalized.tenantUuid)}, project_id=${JSON.stringify(normalized.projectId)}`;
};

const sameIdentity = (left, right) =>
  left.tenantUuid === right.tenantUuid && left.projectId === right.projectId;

const overrideWasTyped = (confirmation) =>
  confirmation === RESTORE_DEPLOYMENT_OVERRIDE_CONFIRMATION;

const overrideInstruction = () =>
  `${RESTORE_DEPLOYMENT_OVERRIDE_ENV}=${RESTORE_DEPLOYMENT_OVERRIDE_CONFIRMATION}`;

export const assertRestoreDeploymentIdentity = ({
  manifest,
  currentIdentity,
  overrideConfirmation,
}) => {
  const current = normalizeDeploymentIdentity(currentIdentity);
  const backupValue = manifest?.deployment;

  if (backupValue === undefined) {
    if (overrideWasTyped(overrideConfirmation)) {
      return {
        backupIdentity: null,
        currentIdentity: current,
        overrideUsed: true,
        legacyIdentityMissing: true,
      };
    }
    throw new Error(
      `Backup deployment identity is missing (legacy backup): backup=unknown; current=${deploymentIdentityLabel(current)}. Refusing restore. If this legacy/cross-deployment restore is intentional, type ${overrideInstruction()}.`,
    );
  }

  let backup;
  try {
    backup = normalizeDeploymentIdentity(backupValue);
  } catch (error) {
    throw new Error(
      `Backup manifest has an invalid deployment identity: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (sameIdentity(backup, current)) {
    return {
      backupIdentity: backup,
      currentIdentity: current,
      overrideUsed: false,
      legacyIdentityMissing: false,
    };
  }

  if (overrideWasTyped(overrideConfirmation)) {
    return {
      backupIdentity: backup,
      currentIdentity: current,
      overrideUsed: true,
      legacyIdentityMissing: false,
    };
  }

  throw new Error(
    `Backup deployment identity mismatch: backup=${deploymentIdentityLabel(backup)}; current=${deploymentIdentityLabel(current)}. Refusing restore. If this cross-deployment restore is intentional, type ${overrideInstruction()}.`,
  );
};

export const mismatchedDeploymentIdentityForRehearsal = (identity) => {
  const current = normalizeDeploymentIdentity(identity);
  const replacement = current.tenantUuid.endsWith("0") ? "1" : "0";
  return {
    ...current,
    tenantUuid: `${current.tenantUuid.slice(0, -1)}${replacement}`,
  };
};
