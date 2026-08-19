import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readLedger } from "./verify-skip.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACT_SCRIPT = resolve(
  SCRIPTS_DIR,
  "check-contract-compatibility.mjs",
);
const ROLLBACK_SCRIPT = resolve(
  SCRIPTS_DIR,
  "check-migration-rollback-compatibility.mjs",
);

const baselineManifest = {
  version: "v1",
  prefix: "/api/v1",
  endpoints: [
    {
      method: "GET",
      path: "/legacy",
      authenticated: true,
      idempotent: false,
    },
  ],
  closedEnums: {},
  requestSchemas: {},
  responseSchemas: {},
};
const breakingManifest = { ...baselineManifest, endpoints: [] };

const git = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
};

const writeManifest = (cwd, manifest) => {
  mkdirSync(join(cwd, "contracts"), { recursive: true });
  writeFileSync(
    join(cwd, "contracts/api-v1.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
};

const makeRepo = () => {
  const cwd = mkdtempSync(join(tmpdir(), "verify-baseref-"));
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "verify-baseref@example.invalid"]);
  git(cwd, ["config", "user.name", "verify baseref test"]);

  writeManifest(cwd, baselineManifest);
  git(cwd, ["add", "contracts/api-v1.json"]);
  git(cwd, ["commit", "-q", "-m", "baseline"]);
  const incompatibleBase = git(cwd, ["rev-parse", "HEAD"]);

  writeManifest(cwd, breakingManifest);
  git(cwd, ["add", "contracts/api-v1.json"]);
  git(cwd, ["commit", "-q", "-m", "current"]);
  const currentCommit = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["update-ref", "refs/remotes/origin/main", currentCommit]);

  return { cwd, incompatibleBase, currentCommit };
};

const gateEnv = (ledger, overrides = {}) => {
  const env = { ...process.env, VERIFY_SKIP_LEDGER: ledger };
  delete env.CONTRACT_BASE_REF;
  delete env.ROLLBACK_BASE_REF;
  delete env.MYSQL_TEST_URL;
  return { ...env, ...overrides };
};

test("contract gate resolves origin/main merge-base locally when env is absent", () => {
  const repo = makeRepo();
  try {
    const ledger = join(repo.cwd, "verify-skips.jsonl");
    const result = spawnSync(process.execPath, [CONTRACT_SCRIPT], {
      cwd: repo.cwd,
      encoding: "utf8",
      env: gateEnv(ledger),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /CONTRACT_BASE_REF not set; using local base from git merge-base origin\/main HEAD: [0-9a-f]+\./u,
    );
    assert.match(result.stdout, /No breaking v1 contract changes detected/u);
    assert.doesNotMatch(result.stdout, /SKIPPED/u);
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("explicit incompatible contract base stays authoritative and turns the gate red", () => {
  const repo = makeRepo();
  try {
    const ledger = join(repo.cwd, "verify-skips.jsonl");
    const result = spawnSync(process.execPath, [CONTRACT_SCRIPT], {
      cwd: repo.cwd,
      encoding: "utf8",
      env: gateEnv(ledger, { CONTRACT_BASE_REF: repo.incompatibleBase }),
    });

    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      new RegExp(
        `Using CONTRACT_BASE_REF from environment: ${repo.incompatibleBase} -> ${repo.incompatibleBase}\\.`,
        "u",
      ),
    );
    assert.match(result.stderr, /endpoint removed: GET \/legacy/u);
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("contract gate records an explicit skip when no local base can be resolved", () => {
  const repo = makeRepo();
  try {
    git(repo.cwd, ["update-ref", "-d", "refs/remotes/origin/main"]);
    const ledger = join(repo.cwd, "verify-skips.jsonl");
    const result = spawnSync(process.execPath, [CONTRACT_SCRIPT], {
      cwd: repo.cwd,
      encoding: "utf8",
      env: gateEnv(ledger),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /SKIPPED: API v1 cross-revision contract compatibility/u,
    );
    assert.match(result.stdout, /origin\/main is unavailable/u);
    const entries = readLedger(ledger).entries;
    assert.equal(entries.length, 1);
    assert.equal(
      entries[0].gate,
      "API v1 cross-revision contract compatibility",
    );
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("rollback gate resolves the local base then records missing MySQL as a skip", () => {
  const repo = makeRepo();
  try {
    const ledger = join(repo.cwd, "verify-skips.jsonl");
    const result = spawnSync(process.execPath, [ROLLBACK_SCRIPT], {
      cwd: repo.cwd,
      encoding: "utf8",
      env: gateEnv(ledger),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /ROLLBACK_BASE_REF not set; using local base from git merge-base origin\/main HEAD: [0-9a-f]+\./u,
    );
    assert.match(
      result.stdout,
      /Checking N-1 compatibility against [0-9a-f]+\./u,
    );
    assert.match(
      result.stdout,
      /SKIPPED: N-1 migration rollback compatibility/u,
    );
    assert.match(result.stdout, /MYSQL_TEST_URL is not set/u);
    assert.match(result.stdout, /doc\/nminus1-migration-rollback\.md/u);
    const entries = readLedger(ledger).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].gate, "N-1 migration rollback compatibility");
    assert.match(entries[0].missing, /MYSQL_TEST_URL is not set/u);
    assert.match(
      entries[0].missing,
      /doc\/nminus1-migration-rollback\.md/u,
    );
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("rollback gate records a skip when origin/main cannot be resolved", () => {
  const repo = makeRepo();
  try {
    git(repo.cwd, ["update-ref", "-d", "refs/remotes/origin/main"]);
    const ledger = join(repo.cwd, "verify-skips.jsonl");
    const result = spawnSync(process.execPath, [ROLLBACK_SCRIPT], {
      cwd: repo.cwd,
      encoding: "utf8",
      env: gateEnv(ledger),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /SKIPPED: N-1 migration rollback compatibility/u,
    );
    assert.match(result.stdout, /origin\/main is unavailable/u);
    const entries = readLedger(ledger).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].gate, "N-1 migration rollback compatibility");
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});
