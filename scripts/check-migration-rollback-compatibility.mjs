import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatBaseResolution,
  resolveGitBaseRef,
} from "./resolve-git-base-ref.mjs";
import { declareSkip } from "./verify-skip.mjs";

const baseResolution = resolveGitBaseRef({
  envName: "ROLLBACK_BASE_REF",
  envValue: process.env.ROLLBACK_BASE_REF,
});
if (!baseResolution.resolved) {
  declareSkip({
    gate: "N-1 migration rollback compatibility",
    missing: `ROLLBACK_BASE_REF unset and local base resolution failed: ${baseResolution.reason}`,
    impact:
      "that the previous application revision still works against the newly migrated schema — i.e. code-only rollback remains viable",
  });
  process.exit(0);
}

console.log(formatBaseResolution("ROLLBACK_BASE_REF", baseResolution));
const baseCommit = baseResolution.commit;
console.log(`Checking N-1 compatibility against ${baseCommit}.`);

const mysqlTestUrl = process.env.MYSQL_TEST_URL;
if (!mysqlTestUrl) {
  throw new Error(
    "MYSQL_TEST_URL is required for N-1 migration compatibility. See doc/nminus1-migration-rollback.md for the dedicated scoped test account.",
  );
}

const { createMySqlPool, defaultMigrations, runMigrations } = await import(
  "../packages/adapters/mysql/dist/index.js"
);

const run = (command, args, cwd, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${
              signal ? `signal ${signal}` : `code ${code}`
            }.`,
          ),
        );
      }
    });
  });

const originalUrl = new URL(mysqlTestUrl);
const originalDatabase =
  decodeURIComponent(originalUrl.pathname.replace(/^\//, "")) ||
  "foundation_test";
const compatibilityDatabase = `${originalDatabase}_nminus1_${process.pid}`
  .replace(/[^A-Za-z0-9_]/g, "_")
  .slice(0, 64);
const adminUrl = new URL(originalUrl);
adminUrl.pathname = "/";
const compatibilityUrl = new URL(originalUrl);
compatibilityUrl.pathname = `/${compatibilityDatabase}`;

const resetCompatibilityDatabase = async () => {
  const admin = createMySqlPool(adminUrl.toString());
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${compatibilityDatabase}\``);
    await admin.query(
      `CREATE DATABASE \`${compatibilityDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end();
  }

  const pool = createMySqlPool(compatibilityUrl.toString());
  try {
    await runMigrations(pool, defaultMigrations);
  } finally {
    await pool.end();
  }
};

const dropCompatibilityDatabase = async () => {
  const admin = createMySqlPool(adminUrl.toString());
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${compatibilityDatabase}\``);
  } finally {
    await admin.end();
  }
};

const compatibilityEnv = {
  ...process.env,
  MYSQL_TEST_URL: compatibilityUrl.toString(),
  MYSQL_URL: compatibilityUrl.toString(),
};

const worktree = await mkdtemp(
  join(tmpdir(), "server-foundation-rollback-compat-"),
);
await rm(worktree, { recursive: true, force: true });

try {
  await run(
    "git",
    ["worktree", "add", "--detach", worktree, baseCommit],
    process.cwd(),
  );
  await run("corepack", ["pnpm", "install", "--frozen-lockfile"], worktree);
  await run("corepack", ["pnpm", "build"], worktree);

  const mysqlTests = (
    await readdir(join(worktree, "packages/adapters/mysql/test"))
  )
    .filter((name) => name.endsWith(".integration.test.ts"))
    .sort();

  for (const testFile of mysqlTests) {
    await resetCompatibilityDatabase();
    console.log(
      `Running N-1 MySQL integration test on current schema: ${testFile}`,
    );
    await run(
      "corepack",
      [
        "pnpm",
        "--filter",
        "@server-foundation/mysql-adapter",
        "exec",
        "vitest",
        "run",
        `test/${testFile}`,
      ],
      worktree,
      compatibilityEnv,
    );
  }

  await run(
    "corepack",
    [
      "pnpm",
      "--filter",
      "@server-foundation/redis-adapter",
      "test:integration",
    ],
    worktree,
    compatibilityEnv,
  );

  for (const testFile of [
    "auth.integration.test.ts",
    "files.integration.test.ts",
  ]) {
    await resetCompatibilityDatabase();
    console.log(
      `Running N-1 API integration test on current schema: ${testFile}`,
    );
    await run(
      "corepack",
      [
        "pnpm",
        "--filter",
        "@server-foundation/api",
        "exec",
        "vitest",
        "run",
        `test/${testFile}`,
      ],
      worktree,
      compatibilityEnv,
    );
  }

  console.log(
    `N-1 application integration tests passed against the current migrated schema (${defaultMigrations
      .map(({ id }) => id)
      .join(", ")}).`,
  );
} finally {
  await dropCompatibilityDatabase().catch(() => undefined);
  await run(
    "git",
    ["worktree", "remove", "--force", worktree],
    process.cwd(),
  ).catch(() => undefined);
  await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
}
