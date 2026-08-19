import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateListenerBoundaries,
  expectationsFromConfig,
  runListenerBoundary,
} from "./listener-boundary.mjs";
import { readLedger } from "./verify-skip.mjs";

const config = {
  HOST: "10.99.0.1",
  PORT: "18787",
  MYSQL_URL: "mysql://user:secret@127.0.0.1:3306/server_foundation",
  REDIS_URL: "redis://127.0.0.1:6379",
};

const goodSs = [
  "LISTEN 0 511 10.99.0.1:18787 0.0.0.0:*",
  "LISTEN 0 151 127.0.0.1:3306 0.0.0.0:*",
  "LISTEN 0 70 127.0.0.1:33060 0.0.0.0:*",
  "LISTEN 0 511 127.0.0.1:6379 0.0.0.0:*",
  "LISTEN 0 511 [::1]:6379 [::]:*",
].join("\n");

const expectations = expectationsFromConfig(config);
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

test("accepts configured API and loopback data-store listeners", () => {
  assert.deepEqual(evaluateListenerBoundaries(goodSs, expectations), {
    passed: ["api", "mysql", "valkey"],
    missing: [],
  });
});

test("wrong API expectations are red", () => {
  assert.throws(
    () =>
      evaluateListenerBoundaries(goodSs, {
        ...expectations,
        api: { host: "0.0.0.0", port: "18787" },
      }),
    /expected host must not be wildcard/u,
  );
  assert.throws(
    () =>
      evaluateListenerBoundaries(goodSs, {
        ...expectations,
        api: { host: "10.99.0.2", port: "18787" },
      }),
    /expected ss column 4/u,
  );
});

test("API config rejects loopback and wildcard hosts", () => {
  assert.throws(
    () => expectationsFromConfig({ ...config, HOST: "127.0.0.1" }),
    /WireGuard-facing address, not loopback/u,
  );
  assert.throws(
    () => expectationsFromConfig({ ...config, HOST: "0.0.0.0" }),
    /must not be a wildcard/u,
  );
});

test("MySQL rejects wildcard classic and X listeners", () => {
  assert.throws(
    () =>
      evaluateListenerBoundaries(
        goodSs.replace("127.0.0.1:3306", "*:3306"),
        expectations,
      ),
    /mysql must not use a wildcard listener: \*:3306/u,
  );
  assert.throws(
    () =>
      evaluateListenerBoundaries(
        goodSs.replace("127.0.0.1:33060", "0.0.0.0:33060"),
        expectations,
      ),
    /mysql must not use a wildcard listener: 0\.0\.0\.0:33060/u,
  );
});

test("Valkey rejects wildcard and non-loopback listeners", () => {
  assert.throws(
    () =>
      evaluateListenerBoundaries(
        goodSs
          .replace("127.0.0.1:6379", "*:6379")
          .replace("[::1]:6379", ""),
        expectations,
      ),
    /valkey must not use a wildcard listener/u,
  );
  assert.throws(
    () =>
      evaluateListenerBoundaries(
        goodSs
          .replace("127.0.0.1:6379", "10.0.0.5:6379")
          .replace("[::1]:6379", ""),
        expectations,
      ),
    /valkey must bind only loopback/u,
  );
});

test("missing services are explicit, never silent passes", () => {
  const onlyApi = "LISTEN 0 511 10.99.0.1:18787 0.0.0.0:*";
  assert.deepEqual(evaluateListenerBoundaries(onlyApi, expectations), {
    passed: ["api"],
    missing: [
      { service: "mysql", port: "3306" },
      { service: "valkey", port: "6379" },
    ],
  });
});

test("missing services use the existing skip ledger hook", async () => {
  const skips = [];
  const logs = [];
  const result = await runListenerBoundary({
    platform: "linux",
    readEnvFile: async () =>
      Object.entries(config)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    readListeners: async () =>
      "LISTEN 0 511 10.99.0.1:18787 0.0.0.0:*\n",
    declareSkipFn: (entry) => skips.push(entry),
    log: (line) => logs.push(line),
  });

  assert.deepEqual(result, {
    skipped: ["mysql", "valkey"],
    passed: ["api"],
  });
  assert.equal(skips.length, 2);
  assert.deepEqual(
    skips.map(({ gate }) => gate),
    ["listener boundary: mysql", "listener boundary: valkey"],
  );
  assert.ok(skips.every(({ impact }) => /listener address/u.test(impact)));
  assert.deepEqual(logs, ["PASS listener-boundary api"]);
});

test("CLI skip path really writes the existing verify ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "listener-boundary-skip-"));
  try {
    const ledger = join(dir, "verify-skips.jsonl");
    const missingEnv = join(dir, "does-not-exist.env");
    const result = spawnSync(
      process.execPath,
      [resolve(SCRIPTS_DIR, "listener-boundary.mjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          VERIFY_SKIP_LEDGER: ledger,
          SERVER_FOUNDATION_ENV_FILE: missingEnv,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SKIPPED: listener boundary/u);
    const entries = readLedger(ledger).entries;
    assert.equal(entries.length, 1, `ledger: ${JSON.stringify(entries)}`);
    assert.equal(entries[0].gate, "listener boundary");
    assert.match(entries[0].impact, /api WireGuard listener/u);
    assert.match(entries[0].impact, /mysql loopback listener/u);
    assert.match(entries[0].impact, /valkey loopback listener/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
