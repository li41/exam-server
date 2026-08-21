import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  acceptanceChecks,
  formatSkipReport,
  parseKeyValueFile,
  parseSsLocalListeners,
  validateListenerBoundary,
  validateReadiness,
} from "./cold-boot-acceptance.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapScript = path.join(
  repoRoot,
  "deploy",
  "scripts",
  "bootstrap-almalinux10.sh",
);

const withFakeTunnelCommands = async (systemctlExitCode, run) => {
  const dir = await mkdtemp(path.join(tmpdir(), "server-foundation-wg-test-"));
  const fakeSudo = path.join(dir, "sudo");
  const fakeSystemctl = path.join(dir, "systemctl");
  const fakeWg = path.join(dir, "wg");

  await writeFile(fakeSudo, '#!/bin/sh\nexec "$@"\n');
  await writeFile(fakeSystemctl, `#!/bin/sh\nexit ${systemctlExitCode}\n`);
  await writeFile(
    fakeWg,
    '#!/bin/sh\n[ "$1" = "show" ] && [ "$2" = "wg0" ] || exit 9\nexit 0\n',
  );
  await Promise.all([
    chmod(fakeSudo, 0o755),
    chmod(fakeSystemctl, 0o755),
    chmod(fakeWg, 0o755),
  ]);

  try {
    await run({ fakeSudo, fakeSystemctl, fakeWg });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runTunnelStartOnly = ({ fakeSudo, fakeSystemctl, fakeWg }) =>
  spawnSync("bash", [bootstrapScript], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      SF_BOOTSTRAP_TEST_WG_START_ONLY: "1",
      SF_SUDO_BIN: fakeSudo,
      SF_SYSTEMCTL_BIN: fakeSystemctl,
      SF_WG_BIN: fakeWg,
    },
  });

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

test("bootstrap exits nonzero when the tunnel unit cannot start", async () => {
  await withFakeTunnelCommands(23, async (commands) => {
    const result = runTunnelStartOnly(commands);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /隧道未建立/u);
    assert.match(result.stderr, /server-foundation 將無法啟動/u);
  });
});

test("bootstrap tunnel-start probe succeeds only when unit and wg0 both succeed", async () => {
  await withFakeTunnelCommands(0, async (commands) => {
    const result = runTunnelStartOnly(commands);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /wg0 已啟動/u);
  });
});
