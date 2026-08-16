import { defaultFileCleanupIntervalMs } from "@server-foundation/local-fs-storage";

export type ServerConfig = {
  nodeEnv: "development" | "test" | "production";
  production: boolean;
  host: string;
  port: number;
  mysqlUrl?: string;
  redisUrl?: string;
  fileStorageRoot?: string;
  deploymentTenantUuid?: string;
  fileCleanupIntervalMs: number;
  idempotencyTtlSeconds: number;
  trustProxyHeaders: boolean;
  shutdownTimeoutMs: number;
};

const tenantUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const parseInteger = (
  name: string,
  raw: string | undefined,
  options: { defaultValue: number; min: number; max: number },
): number => {
  if (raw === undefined || raw.trim() === "") return options.defaultValue;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < options.min ||
    value > options.max
  ) {
    throw new Error(
      `${name} must be an integer between ${options.min} and ${options.max}.`,
    );
  }
  return value;
};

const parseBoolean = (
  name: string,
  raw: string | undefined,
  defaultValue = false,
): boolean => {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be either true or false.`);
};

const parseHost = (raw: string | undefined): string => {
  const value = raw?.trim() || "127.0.0.1";
  if (
    value.length > 255 ||
    /[\s/\\\r\n]/.test(value) ||
    !/^[a-zA-Z0-9.:-]+$/.test(value)
  ) {
    throw new Error(
      "HOST must be a hostname or IP address without a scheme or path.",
    );
  }
  return value;
};

const parseOptionalUrl = (
  name: string,
  raw: string | undefined,
  allowedProtocols: readonly string[],
): string | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${name} must be a valid URL.`, { cause: error });
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`${name} must use one of: ${allowedProtocols.join(", ")}.`);
  }
  return value;
};

const parseOptionalTenantUuid = (
  raw: string | undefined,
): string | undefined => {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (!tenantUuidPattern.test(value)) {
    throw new Error(
      "DEPLOYMENT_TENANT_UUID must be an exam-control tenant_uuid UUIDv4.",
    );
  }
  return value;
};

const parseNodeEnv = (raw: string | undefined): ServerConfig["nodeEnv"] => {
  const value = raw?.trim() || "development";
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  throw new Error("NODE_ENV must be development, test, or production.");
};

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig => {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const mysqlUrl = parseOptionalUrl("MYSQL_URL", env.MYSQL_URL, ["mysql:"]);
  const redisUrl = parseOptionalUrl("REDIS_URL", env.REDIS_URL, [
    "redis:",
    "rediss:",
  ]);
  const fileStorageRoot = env.FILE_STORAGE_ROOT?.trim() || undefined;
  const deploymentTenantUuid = parseOptionalTenantUuid(
    env.DEPLOYMENT_TENANT_UUID,
  );
  const fileCleanupIntervalSeconds = parseInteger(
    "FILE_CLEANUP_INTERVAL_SECONDS",
    env.FILE_CLEANUP_INTERVAL_SECONDS,
    {
      defaultValue: Math.floor(defaultFileCleanupIntervalMs / 1000),
      min: 1,
      max: Math.floor(Number.MAX_SAFE_INTEGER / 1000),
    },
  );
  const production = nodeEnv === "production";

  if (
    production &&
    (!mysqlUrl || !redisUrl || !fileStorageRoot || !deploymentTenantUuid)
  ) {
    throw new Error(
      "MYSQL_URL, REDIS_URL, FILE_STORAGE_ROOT, and DEPLOYMENT_TENANT_UUID are required when NODE_ENV=production.",
    );
  }
  if (redisUrl && !mysqlUrl) {
    throw new Error("MYSQL_URL is required when REDIS_URL is configured.");
  }

  return {
    nodeEnv,
    production,
    host: parseHost(env.HOST),
    port: parseInteger("PORT", env.PORT, {
      defaultValue: 8787,
      min: 1,
      max: 65535,
    }),
    mysqlUrl,
    redisUrl,
    fileStorageRoot,
    deploymentTenantUuid,
    fileCleanupIntervalMs: fileCleanupIntervalSeconds * 1000,
    idempotencyTtlSeconds: parseInteger(
      "IDEMPOTENCY_TTL_SECONDS",
      env.IDEMPOTENCY_TTL_SECONDS,
      { defaultValue: 86_400, min: 60, max: 604_800 },
    ),
    trustProxyHeaders: parseBoolean(
      "TRUST_PROXY_HEADERS",
      env.TRUST_PROXY_HEADERS,
    ),
    shutdownTimeoutMs:
      parseInteger("SHUTDOWN_TIMEOUT_SECONDS", env.SHUTDOWN_TIMEOUT_SECONDS, {
        defaultValue: 30,
        min: 1,
        max: 300,
      }) * 1000,
  };
};
