import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  INTERNAL_PACKAGES_ROOT,
  MINIMUM_INTERNAL_RUNTIME_PACKAGES,
  REPO_ROOT,
  discoverInternalPackages,
  runRuntimeExportSmoke,
} from "./runtime-export-smoke.mjs";

const withFixture = (fn) => {
  const root = mkdtempSync(join(tmpdir(), "runtime-export-smoke-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const writeInternalPackage = (
  fixtureRoot,
  {
    directory = "probe",
    name = "@server-foundation/runtime-export-probe",
    importTarget = "./dist/index.js",
    writeRuntime = true,
  } = {},
) => {
  const packageDirectory = join(fixtureRoot, "packages", directory);
  const distDirectory = join(packageDirectory, "dist");
  const srcDirectory = join(packageDirectory, "src");
  mkdirSync(distDirectory, { recursive: true });
  mkdirSync(srcDirectory, { recursive: true });

  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: importTarget,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(distDirectory, "index.d.ts"),
    "export declare const runtimeValue: 1;\n",
    "utf8",
  );
  if (writeRuntime) {
    writeFileSync(
      join(distDirectory, "index.js"),
      "export const runtimeValue = 1;\n",
      "utf8",
    );
  }

  const consumer = join(srcDirectory, "consumer.ts");
  writeFileSync(
    consumer,
    `import { runtimeValue } from ${JSON.stringify(name)};\n` +
      "const exact: 1 = runtimeValue;\n" +
      "void exact;\n",
    "utf8",
  );

  return { packageDirectory, consumer, name };
};

const assertFixtureTypecheckPasses = (consumer) => {
  const result = spawnSync(
    "corepack",
    [
      "pnpm",
      "exec",
      "tsc",
      "--noEmit",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--target",
      "ES2022",
      "--strict",
      consumer,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
    },
  );
  assert.equal(
    result.status,
    0,
    `fixture tsc --noEmit must be green before testing runtime resolution\n${result.stdout}\n${result.stderr}`,
  );
};

test("normal internal package root import is green", () => {
  withFixture((root) => {
    const { name } = writeInternalPackage(root, {
      directory: "adapters/probe",
    });
    const imported = runRuntimeExportSmoke({
      packagesRoot: join(root, "packages"),
      minimumPackageCount: 1,
    });
    assert.deepEqual(imported, [name]);
  });
});

test("broken exports.import is red even when tsc --noEmit is green", () => {
  withFixture((root) => {
    const { consumer, name } = writeInternalPackage(root, {
      importTarget: "./dist/does-not-exist.js",
      writeRuntime: false,
    });

    // This is the discriminator required by #83: if this is red, the test only
    // proved that TypeScript catches the mutation, not that runtime resolution
    // adds coverage beyond typecheck.
    assertFixtureTypecheckPasses(consumer);

    assert.throws(
      () =>
        runRuntimeExportSmoke({
          packagesRoot: join(root, "packages"),
          minimumPackageCount: 1,
        }),
      (error) => {
        assert.match(String(error), new RegExp(name.replace("/", "\\/"), "u"));
        assert.match(String(error), /ERR_MODULE_NOT_FOUND/u);
        return true;
      },
    );
  });
});

test("discovery floor fails closed instead of accepting an incomplete scan", () => {
  withFixture((root) => {
    writeInternalPackage(root);
    assert.throws(
      () =>
        runRuntimeExportSmoke({
          packagesRoot: join(root, "packages"),
          minimumPackageCount: 2,
        }),
      /discovered 1 internal package.*expected at least 2.*false green/u,
    );
  });
});

test("repository discovery reaches the known minimum internal package floor", () => {
  const packages = discoverInternalPackages(INTERNAL_PACKAGES_ROOT);
  assert.ok(
    packages.length >= MINIMUM_INTERNAL_RUNTIME_PACKAGES,
    `discovered ${packages.length}; expected at least ${MINIMUM_INTERNAL_RUNTIME_PACKAGES}`,
  );
});
