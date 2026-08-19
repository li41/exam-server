import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const INTERNAL_PACKAGES_ROOT = join(REPO_ROOT, "packages");

// 2026-08-19 baseline: api-contracts, domain, auth, testing, mysql-adapter,
// redis-adapter, and local-fs-storage. This is intentionally a floor, not an
// equality assertion: adding a new internal library should make the smoke test
// cover more packages without first changing this constant. Dropping below the
// floor is fail-closed because "0 failures" is meaningless if discovery broke.
export const MINIMUM_INTERNAL_RUNTIME_PACKAGES = 7;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);

const readManifest = (manifestPath) => {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read package manifest ${manifestPath}.`, {
      cause: error,
    });
  }
};

/**
 * Discover internal library packages under packages/**.
 *
 * Deliberately do not filter on `exports`: a package that accidentally loses
 * its root export must still be handed to Node and fail, not disappear from the
 * candidate set and turn the gate green by omission.
 *
 * @param {string} [packagesRoot]
 * @returns {{ name: string, directory: string, manifestPath: string }[]}
 */
export function discoverInternalPackages(
  packagesRoot = INTERNAL_PACKAGES_ROOT,
) {
  if (!existsSync(packagesRoot)) {
    throw new Error(`Internal packages root does not exist: ${packagesRoot}`);
  }

  const packages = [];

  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;

      const child = join(directory, entry.name);
      const manifestPath = join(child, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = readManifest(manifestPath);
        if (
          typeof manifest.name === "string" &&
          manifest.name.startsWith("@server-foundation/")
        ) {
          packages.push({
            name: manifest.name,
            directory: child,
            manifestPath,
          });
        }
      }

      visit(child);
    }
  };

  visit(packagesRoot);
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {string[]} importedPackageNames
 * @param {number} [minimumPackageCount]
 * @returns {void}
 */
export function assertRuntimeImportFloor(
  importedPackageNames,
  minimumPackageCount = MINIMUM_INTERNAL_RUNTIME_PACKAGES,
) {
  if (!Number.isInteger(minimumPackageCount) || minimumPackageCount < 1) {
    throw new Error(
      `runtime-export smoke minimum must be a positive integer (got ${minimumPackageCount}).`,
    );
  }
  if (importedPackageNames.length < minimumPackageCount) {
    throw new Error(
      `runtime-export smoke imported ${importedPackageNames.length} internal package root(s); ` +
        `expected at least ${minimumPackageCount}. Refusing a possible false green from incomplete discovery/import coverage.`,
    );
  }
}

/**
 * Import one package by its bare package name from inside that package scope.
 * Node package self-reference therefore resolves the root `exports` entry and
 * its runtime `import` condition. We intentionally do not read an export target
 * ourselves, because doing so would bypass the resolver this gate exists to test.
 *
 * @param {{ name: string, directory: string, manifestPath: string }} packageInfo
 * @returns {string}
 */
export function importPackageRoot(packageInfo) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(packageInfo.name)});`,
    ],
    {
      cwd: packageInfo.directory,
      encoding: "utf8",
      env: process.env,
    },
  );

  if (result.error) {
    throw new Error(`Unable to launch Node for ${packageInfo.name}.`, {
      cause: result.error,
    });
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .join("\n")
      .trim();
    throw new Error(
      `Node runtime-export import failed for ${packageInfo.name} ` +
        `(${relative(REPO_ROOT, packageInfo.manifestPath)}).` +
        (output ? `\n${output}` : ""),
    );
  }

  return packageInfo.name;
}

/**
 * @param {{ packagesRoot?: string, minimumPackageCount?: number }} [options]
 * @returns {string[]} imported package names
 */
export function runRuntimeExportSmoke({
  packagesRoot = INTERNAL_PACKAGES_ROOT,
  minimumPackageCount = MINIMUM_INTERNAL_RUNTIME_PACKAGES,
} = {}) {
  const packages = discoverInternalPackages(packagesRoot);
  const imported = packages.map(importPackageRoot);
  assertRuntimeImportFloor(imported, minimumPackageCount);
  return imported;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const imported = runRuntimeExportSmoke();
    console.log(
      `runtime-export smoke: imported ${imported.length} internal package root entries.`,
    );
    for (const name of imported) console.log(`  ok ${name}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
