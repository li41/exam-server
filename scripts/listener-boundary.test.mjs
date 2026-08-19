import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateListenerBoundaries,
  expectationsFromConfig,
  runListenerBoundary,
} from "./listener-boundary.mjs";

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

test("accepts API on configured WireGuard address and data stores on loopback", () => {
  assert.deepEqual(evaluateListenerBoundaries(goodSs, expectations), {
    passed: ["api", "mysql", "valkey"],
    missing: [],
  });
});

test("wrong API expectation is red, including the wildcard mutation", () => {
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

test("API config cannot encode the old loopback or wildcard hole", () => {
  assert.throws(
    () => expectationsFromConfig({ ...config, HOST: "127.0.0.1" }),
    /WireGuard-facing address, not loopback/u,
  );
  assert.throws(
    () => expectationsFromConfig({ ...config, HOST: "0.0.0.0" }),
    /must not be a wildcard/u,
  );
});

test("MySQL rejects wildcard listeners on both classic and X protocol ports", () => {
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

test("missing services are explicit missing results, never silent passes", () => {
  const onlyApi = "LISTEN 0 511 10.99.0.1:18787 0.0.0.0:*";
  assert.deepEqual(evaluateListenerBoundaries(onlyApi, expectations), {
    passed: ["api"],
    missing: [
      { service: "mysql", port: "3306" },
      { service: "valkey", port: "6379" },
    ],
  });
});

test("runtime gate registers each missing service with the existing skip ledger hook", async () => {
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

  assert.deepEqual(result, { skipped: ["mysql", "valkey"], passed: ["api"] });
  assert.equal(skips.length, 2);
  assert.deepEqual(
    skips.map(({ gate }) => gate),
    ["listener boundary: mysql", "listener boundary: valkey"],
  );
  assert.ok(skips.every(({ impact }) => /listener address/u.test(impact)));
  assert.deepEqual(logs, ["PASS listener-boundary api"]);
});
