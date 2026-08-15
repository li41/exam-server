import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceChecks,
  formatSkipReport,
  parseKeyValueFile,
  parseSsLocalListeners,
  validateListenerBoundary,
  validateReadiness,
} from "./cold-boot-acceptance.mjs";

test("parses service env values as data instead of shell", () => {
  assert.deepEqual(
    parseKeyValueFile(
      `\n# comment\nHOST=10.99.0.1\nPORT=18787\nQUOTED="value"\n`,
    ),
    { HOST: "10.99.0.1", PORT: "18787", QUOTED: "value" },
  );
});

test("listener validation uses ss column 4, not peer column 5", () => {
  const output =
    'LISTEN 0 511 10.99.0.1:18787 0.0.0.0:* users:(("node",pid=123,fd=20))\n';
  const listeners = parseSsLocalListeners(output, "18787");
  assert.deepEqual(listeners, ["10.99.0.1:18787"]);
  assert.doesNotThrow(() =>
    validateListenerBoundary(listeners, "10.99.0.1", "18787"),
  );
});

test("listener validation rejects wildcard or extra local listeners", () => {
  assert.throws(
    () => validateListenerBoundary(["0.0.0.0:18787"], "0.0.0.0", "18787"),
    /must not be a wildcard/u,
  );
  assert.throws(
    () =>
      validateListenerBoundary(
        ["10.99.0.1:18787", "127.0.0.1:18787"],
        "10.99.0.1",
        "18787",
      ),
    /expected ss column 4/u,
  );
});

test("readiness requires mysql, redis, and storage checks all ok", () => {
  const healthy = {
    status: "ok",
    checks: {
      mysql: { status: "ok" },
      redis: { status: "ok" },
      storage: { status: "ok" },
    },
  };
  assert.doesNotThrow(() => validateReadiness(healthy));
  assert.throws(
    () =>
      validateReadiness({
        ...healthy,
        checks: { ...healthy.checks, redis: { status: "error" } },
      }),
    /redis/u,
  );
});

test("skip report explicitly names every real-machine check", () => {
  const lines = formatSkipReport("systemd unavailable");
  assert.equal(lines.length, acceptanceChecks.length);
  for (const name of acceptanceChecks) {
    assert.ok(lines.includes(`SKIP ${name}: systemd unavailable`));
  }
});
