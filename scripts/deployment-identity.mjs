import { readFile } from "node:fs/promises";

export const DEPLOYMENT_COMPANY_ID_KEY = "DEPLOYMENT_COMPANY_ID";
export const DEPLOYMENT_PROJECT_ID_KEY = "DEPLOYMENT_PROJECT_ID";
export const RESTORE_DEPLOYMENT_OVERRIDE_ENV =
  "RESTORE_DEPLOYMENT_OVERRIDE_CONFIRM";
export const RESTORE_DEPLOYMENT_OVERRIDE_CONFIRMATION =
  "YES_I_UNDERSTAND_THIS_BACKUP_IS_FOR_A_DIFFERENT_DEPLOYMENT";

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

const companyId = (value) => {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new Error(
      `${DEPLOYMENT_COMPANY_ID_KEY} must be a positive exam-control company_id integer.`,
    );
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${DEPLOYMENT_COMPANY_ID_KEY} exceeds JavaScript safe integer range.`);
  }
  return parsed;
};

export const deploymentIdentityFromValues = (values) => ({
  companyId: companyId(values?.[DEPLOYMENT_COMPANY_ID_KEY]),
  projectId: projectId(values?.[DEPLOYMENT_PROJECT_ID_KEY]),
});

export const normalizeDeploymentIdentity = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deployment identity must be an object.");
  }
  return {
    companyId: companyId(value.companyId),
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
    if (key !== DEPLOYMENT_COMPANY_ID_KEY && key !== DEPLOYMENT_PROJECT_ID_KEY) {
      continue;
    }
    if (Object.hasOwn(values, key)) {
      throw new Error(`Deployment identity env has duplicate ${key} at line ${index + 1}.`);
    }
    values[key] = line.slice(separator + 1).trim();
  }
  return deploymentIdentityFromValues(values);
};

export const deploymentIdentityLabel = (identity) => {
  const normalized = normalizeDeploymentIdentity(identity);
  return `company_id=${normalized.companyId}, project_id=${JSON.stringify(normalized.projectId)}`;
};

const sameIdentity = (left, right) =>
  left.companyId === right.companyId && left.projectId === right.projectId;

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
  return {
    ...current,
    companyId:
      current.companyId === Number.MAX_SAFE_INTEGER
        ? current.companyId - 1
        : current.companyId + 1,
  };
};
