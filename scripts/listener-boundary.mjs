import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  parseKeyValueFile,
  parseSsLocalListeners,
  validateListenerBoundary,
} from "./cold-boot-acceptance.mjs";
import { declareSkip } from "./verify-skip.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_ENV_FILE = "/etc/server-foundation/server-foundation.env";
const MYSQL_X_PORT = "33060";
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const FULL_IMPACT =
  "api WireGuard listener, mysql loopback listener, valkey loopback listener";

const normalizeHost = (host) => {
  const value = String(host).trim();
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
};

const configValue = (config, name) => {
  const value = config[name]?.trim();
  if (!value) throw new Error(`${name} is missing from the service env file`);
  return value;
};

const validPort = (port, label) => {
  const value = String(port);
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${label} port is invalid: ${value}`);
  }
  return value;
};

const listenerHost = (localAddress, port) => {
  const suffix = `:${port}`;
  if (!localAddress.endsWith(suffix)) {
    throw new Error(`listener ${localAddress} does not end with ${suffix}`);
  }
  return normalizeHost(localAddress.slice(0, -suffix.length));
};

const isWildcardHost = (host) => WILDCARD_HOSTS.has(normalizeHost(host));
const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(normalizeHost(host));

const parseServiceUrl = (config, name, defaultPort) => {
  let parsed;
  try {
    parsed = new URL(configValue(config, name));
  } catch (error) {
    throw new Error(`${name} is not a valid URL`, { cause: error });
  }
  const host = normalizeHost(parsed.hostname);
  if (!isLoopbackHost(host)) {
    throw new Error(`${name} must point at loopback; got ${host}`);
  }
  return {
    host,
    port: validPort(parsed.port || defaultPort, name),
  };
};

export function expectationsFromConfig(config) {
  const apiHost = normalizeHost(configValue(config, "HOST"));
  if (isWildcardHost(apiHost)) {
    throw new Error(`API HOST must not be a wildcard listener: ${apiHost}`);
  }
  if (isLoopbackHost(apiHost)) {
    throw new Error(
      `API HOST must be the WireGuard-facing address, not loopback: ${apiHost}`,
    );
  }
  return {
    api: {
      host: apiHost,
      port: validPort(configValue(config, "PORT"), "API"),
    },
    mysql: parseServiceUrl(config, "MYSQL_URL", "3306"),
    valkey: parseServiceUrl(config, "REDIS_URL", "6379"),
  };
}

export function validateLoopbackListeners(listeners, service, port) {
  if (listeners.length === 0) return;
  for (const localAddress of listeners) {
    const host = listenerHost(localAddress, port);
    if (isWildcardHost(host)) {
      throw new Error(
        `${service} must not use a wildcard listener: ${localAddress}`,
      );
    }
    if (!isLoopbackHost(host)) {
      throw new Error(
        `${service} must bind only loopback; got ${localAddress}`,
      );
    }
  }
}

export function evaluateListenerBoundaries(output, expectations) {
  const passed = [];
  const missing = [];

  const apiHost = normalizeHost(expectations.api.host);
  if (isWildcardHost(apiHost)) {
    throw new Error(`API expected host must not be wildcard: ${apiHost}`);
  }
  if (isLoopbackHost(apiHost)) {
    throw new Error(`API expected host must be WireGuard-facing: ${apiHost}`);
  }
  const apiPort = validPort(expectations.api.port, "API");
  const apiListeners = parseSsLocalListeners(output, apiPort);
  if (apiListeners.length === 0) {
    missing.push({ service: "api", port: apiPort });
  } else {
    validateListenerBoundary(apiListeners, apiHost, apiPort);
    passed.push("api");
  }

  const mysqlPort = validPort(expectations.mysql.port, "MYSQL_URL");
  const mysqlListeners = parseSsLocalListeners(output, mysqlPort);
  const mysqlXListeners =
    mysqlPort === MYSQL_X_PORT
      ? []
      : parseSsLocalListeners(output, MYSQL_X_PORT);
  validateLoopbackListeners(mysqlXListeners, "mysql", MYSQL_X_PORT);
  if (mysqlListeners.length === 0) {
    missing.push({ service: "mysql", port: mysqlPort });
  } else {
    validateLoopbackListeners(mysqlListeners, "mysql", mysqlPort);
    passed.push("mysql");
  }

  const valkeyPort = validPort(expectations.valkey.port, "REDIS_URL");
  const valkeyListeners = parseSsLocalListeners(output, valkeyPort);
  if (valkeyListeners.length === 0) {
    missing.push({ service: "valkey", port: valkeyPort });
  } else {
    validateLoopbackListeners(valkeyListeners, "valkey", valkeyPort);
    passed.push("valkey");
  }

  return { passed, missing };
}

const readListenersWithSs = async () => {
  const { stdout = "" } = await execFileAsync("ss", ["-H", "-ltn"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return stdout;
};

const skipWholeGate = (declareSkipFn, missing) => {
  declareSkipFn({
    gate: "listener boundary",
    missing,
    impact: FULL_IMPACT,
  });
};

export async function runListenerBoundary({
  env = process.env,
  platform = process.platform,
  readEnvFile = (path) => readFile(path, "utf8"),
  readListeners = readListenersWithSs,
  declareSkipFn = declareSkip,
  log = console.log,
} = {}) {
  if (platform !== "linux") {
    skipWholeGate(
      declareSkipFn,
      `requires Linux ss -ltn; current platform=${platform}`,
    );
    return { skipped: ["api", "mysql", "valkey"], passed: [] };
  }

  const envFile = env.SERVER_FOUNDATION_ENV_FILE ?? DEFAULT_ENV_FILE;
  let config;
  try {
    config = parseKeyValueFile(await readEnvFile(envFile));
  } catch (error) {
    skipWholeGate(
      declareSkipFn,
      `cannot read ${envFile}: ${error instanceof Error ? error.message : error}`,
    );
    return { skipped: ["api", "mysql", "valkey"], passed: [] };
  }

  const expectations = expectationsFromConfig(config);
  let output;
  try {
    output = await readListeners();
  } catch (error) {
    skipWholeGate(
      declareSkipFn,
      `cannot run ss -ltn: ${error instanceof Error ? error.message : error}`,
    );
    return { skipped: ["api", "mysql", "valkey"], passed: [] };
  }

  const result = evaluateListenerBoundaries(output, expectations);
  for (const service of result.passed) {
    log(`PASS listener-boundary ${service}`);
  }
  for (const { service, port } of result.missing) {
    declareSkipFn({
      gate: `listener boundary: ${service}`,
      missing: `${service} is not listening on expected port ${port}`,
      impact: `${service} listener address was not verified`,
    });
  }
  if (result.missing.length === 0) log("PASS listener-boundary");
  return {
    skipped: result.missing.map(({ service }) => service),
    passed: result.passed,
  };
}

const main = async () => {
  await runListenerBoundary();
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
