#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_ALERT_ENV_FILE = "/etc/server-foundation/outage-alert.env";
const DEFAULT_SERVER_ENV_FILE = "/etc/server-foundation/server-foundation.env";
const REQUIRED_READY_CHECKS = ["mysql", "redis", "storage"];
const ALLOWED_ALERT_KEYS = new Set([
  "HEALTHCHECKS_PING_URL",
  "OUTAGE_HEALTH_TIMEOUT_SECONDS",
  "OUTAGE_PING_TIMEOUT_SECONDS",
  "OUTAGE_PING_RETRIES",
]);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export const parseDataEnv = (text, { allowedKeys } = {}) => {
  const values = {};
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(`invalid env line ${index + 1}`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new Error(`invalid env key on line ${index + 1}`);
    }
    if (allowedKeys && !allowedKeys.has(key)) {
      throw new Error(`unknown env key: ${key}`);
    }
    if (Object.hasOwn(values, key)) {
      throw new Error(`duplicate env key: ${key}`);
    }
    values[key] = value;
  }
  return values;
};

const positiveInteger = (value, fallback, name) => {
  const candidate =
    value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return candidate;
};

export const normalizePingUrl = (raw) => {
  if (!raw || raw === "CHANGE_ME") {
    throw new Error("HEALTHCHECKS_PING_URL is not configured");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("HEALTHCHECKS_PING_URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new Error("HEALTHCHECKS_PING_URL must use https");
  }
  if (url.username || url.password || url.hash) {
    throw new Error(
      "HEALTHCHECKS_PING_URL contains unsupported URL components",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (!url.pathname || url.pathname === "/") {
    throw new Error("HEALTHCHECKS_PING_URL must identify a check");
  }
  return url;
};

export const healthUrlFromServerEnv = (serverEnv) => {
  const host = serverEnv.HOST?.trim();
  const port = positiveInteger(serverEnv.PORT, undefined, "PORT");
  if (!host) throw new Error("HOST is missing from server environment");
  const address =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`http://${address}:${port}/health/ready`);
};

export const validateReadiness = (payload) => {
  if (
    !payload ||
    payload.status !== "ok" ||
    typeof payload.checks !== "object"
  ) {
    throw new Error("readiness status is not ok");
  }
  for (const name of REQUIRED_READY_CHECKS) {
    if (payload.checks?.[name]?.status !== "ok") {
      throw new Error(`readiness check is not ok: ${name}`);
    }
  }
};

export const checkReadiness = async (
  healthUrl,
  { fetchImpl = fetch, timeoutSeconds = 10 } = {},
) => {
  const response = await fetchImpl(healthUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  if (!response.ok) {
    throw new Error(`readiness HTTP ${response.status}`);
  }
  validateReadiness(await response.json());
};

export const signalUrlFor = (baseUrl, signal) => {
  const url = new URL(baseUrl);
  if (signal === "failure") {
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/fail`;
  }
  return url;
};

export const sendSignal = async (
  baseUrl,
  signal = "success",
  {
    fetchImpl = fetch,
    timeoutSeconds = 10,
    retries = 3,
    sleepImpl = sleep,
  } = {},
) => {
  const url = signalUrlFor(baseUrl, signal);
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
      if (!response.ok) throw new Error(`heartbeat HTTP ${response.status}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleepImpl(attempt * 1000);
    }
  }
  const message =
    lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(
    `heartbeat delivery failed after ${retries} attempts: ${message}`,
  );
};

export const loadConfig = async ({ readFileImpl = readFile } = {}) => {
  const alertEnvFile =
    process.env.OUTAGE_ALERT_ENV_FILE ?? DEFAULT_ALERT_ENV_FILE;
  const serverEnvFile =
    process.env.SERVER_FOUNDATION_ENV_FILE ?? DEFAULT_SERVER_ENV_FILE;
  const alertEnv = parseDataEnv(await readFileImpl(alertEnvFile, "utf8"), {
    allowedKeys: ALLOWED_ALERT_KEYS,
  });
  const serverEnv = parseDataEnv(await readFileImpl(serverEnvFile, "utf8"));
  return {
    pingUrl: normalizePingUrl(alertEnv.HEALTHCHECKS_PING_URL),
    healthUrl: healthUrlFromServerEnv(serverEnv),
    healthTimeoutSeconds: positiveInteger(
      alertEnv.OUTAGE_HEALTH_TIMEOUT_SECONDS,
      10,
      "OUTAGE_HEALTH_TIMEOUT_SECONDS",
    ),
    pingTimeoutSeconds: positiveInteger(
      alertEnv.OUTAGE_PING_TIMEOUT_SECONDS,
      10,
      "OUTAGE_PING_TIMEOUT_SECONDS",
    ),
    pingRetries: positiveInteger(
      alertEnv.OUTAGE_PING_RETRIES,
      3,
      "OUTAGE_PING_RETRIES",
    ),
  };
};

export const runHeartbeat = async (
  options = {},
  {
    config = undefined,
    fetchImpl = fetch,
    sleepImpl = sleep,
    log = console.log,
  } = {},
) => {
  const resolved = config ?? (await loadConfig());
  if (options.testAlert) {
    await sendSignal(resolved.pingUrl, "failure", {
      fetchImpl,
      timeoutSeconds: resolved.pingTimeoutSeconds,
      retries: resolved.pingRetries,
      sleepImpl,
    });
    log("test outage signal sent; verify external notification delivery");
    return;
  }
  await checkReadiness(resolved.healthUrl, {
    fetchImpl,
    timeoutSeconds: resolved.healthTimeoutSeconds,
  });
  await sendSignal(resolved.pingUrl, "success", {
    fetchImpl,
    timeoutSeconds: resolved.pingTimeoutSeconds,
    retries: resolved.pingRetries,
    sleepImpl,
  });
  log("readiness ok; external heartbeat sent");
};

export const parseArgs = (argv) => {
  const options = { testAlert: false };
  for (const argument of argv) {
    if (argument === "--test-alert") options.testAlert = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
};

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runHeartbeat(parseArgs(process.argv.slice(2))).catch((error) => {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`outage heartbeat failed: ${message}`);
    process.exitCode = 1;
  });
}
