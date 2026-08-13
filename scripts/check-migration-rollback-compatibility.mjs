import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const baseRef = process.env.ROLLBACK_BASE_REF;
if (!baseRef) {
  console.log(
    "ROLLBACK_BASE_REF is not set; skipping N-1 migration compatibility check.",
  );
  process.exit(0);
}

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}.`),
        );
    });
  });

await run("git", ["rev-parse", "--verify", `${baseRef}^{commit}`]);

const worktree = await mkdtemp(
  join(tmpdir(), "server-foundation-rollback-compat-"),
);

try {
  await run("git", ["worktree", "add", "--detach", worktree, baseRef]);
  await run(
    "corepack",
    ["pnpm", "--dir", worktree, "install", "--frozen-lockfile"],
    { env: process.env },
  );
  await run("corepack", ["pnpm", "--dir", worktree, "build"], {
    env: process.env,
  });
  await run("corepack", ["pnpm", "--dir", worktree, "test:integration"], {
    env: process.env,
  });
  console.log(
    `N-1 application ${baseRef} passed integration tests against the migrated schema.`,
  );
} finally {
  await run("git", ["worktree", "remove", "--force", worktree]).catch(
    () => undefined,
  );
  await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
}
