#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_SOURCE = path.join(
  ROOT,
  "packages",
  "adapters",
  "mysql",
  "src",
  "migrate.ts",
);
const MIGRATION_ENTRY_PATTERN =
  /\{\s*id:\s*["']([^"']+)["']\s*,\s*file:\s*new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)\s*,?\s*\}/g;
const NUMBER_PREFIX_PATTERN = /^(\d+)_/;
const SQL_FILE_PATTERN = /^(\d+)_.*\.sql$/;

/**
 * @typedef {{ id: string, file: string | URL }} MigrationEntry
 */

/**
 * 只解析 defaultMigrations 陣列；真相源是 migrate.ts，不掃 schema 檔名。
 *
 * @param {string} source
 * @param {string} sourceFile
 * @returns {MigrationEntry[]}
 */
export function parseMigrationSource(source, sourceFile) {
  const declaration = "export const defaultMigrations";
  const declarationIndex = source.indexOf(declaration);
  if (declarationIndex < 0) {
    throw new Error(`找不到 ${declaration}。`);
  }

  const arrayStart = source.indexOf("[", declarationIndex);
  const arrayEnd = source.indexOf("];", arrayStart);
  if (arrayStart < 0 || arrayEnd < 0) {
    throw new Error("找不到 defaultMigrations 陣列結尾。");
  }

  const arraySource = source.slice(arrayStart + 1, arrayEnd);
  const entries = [...arraySource.matchAll(MIGRATION_ENTRY_PATTERN)].map(
    ([, id, fileSpecifier]) => ({
      id,
      file: fileURLToPath(new URL(fileSpecifier, pathToFileURL(sourceFile))),
    }),
  );
  const declaredEntryCount = (arraySource.match(/\bid\s*:/g) ?? []).length;
  if (entries.length !== declaredEntryCount || entries.length === 0) {
    throw new Error(
      `defaultMigrations 陣列有無法解析的項目：解析 ${entries.length} 筆，宣告 ${declaredEntryCount} 筆。`,
    );
  }

  return entries;
}

/**
 * @param {MigrationEntry} migration
 * @returns {string}
 */
function migrationFilePath(migration) {
  return migration.file instanceof URL
    ? fileURLToPath(migration.file)
    : migration.file;
}

/**
 * @param {string} value
 * @returns {{prefix: string, number: number} | null}
 */
function numberPrefix(value) {
  const match = value.match(NUMBER_PREFIX_PATTERN);
  if (!match) return null;
  return { prefix: match[1], number: Number(match[1]) };
}

/**
 * @param {MigrationEntry[]} migrations
 * @returns {string[]}
 */
export function validateMigrations(migrations) {
  const problems = [];
  const seenPrefixes = new Set();

  for (const [index, migration] of migrations.entries()) {
    const idPrefix = numberPrefix(migration.id);
    const filePath = migrationFilePath(migration);
    const fileName = path.basename(filePath);
    const fileMatch = fileName.match(SQL_FILE_PATTERN);

    if (!idPrefix) {
      problems.push(`id 沒有數字前綴：${migration.id}`);
    } else {
      if (seenPrefixes.has(idPrefix.number)) {
        problems.push(`編號前綴重複：${idPrefix.prefix}`);
      }
      seenPrefixes.add(idPrefix.number);

      const expectedNumber = index + 1;
      if (idPrefix.number !== expectedNumber) {
        problems.push(
          `編號未從 001 起連續遞增：第 ${index + 1} 筆預期 ${String(expectedNumber).padStart(3, "0")}，實際 ${idPrefix.prefix}`,
        );
      }
    }

    if (!fileMatch || !idPrefix || Number(fileMatch[1]) !== idPrefix.number) {
      problems.push(
        `id 與 file 編號不一致：id=${migration.id}，file=${fileName}`,
      );
    }

    if (!existsSync(filePath)) {
      problems.push(`migration file 不存在：${filePath}`);
    }
  }

  return problems;
}

/**
 * 自我檢查必須先通過，才檢查真的 migrate.ts。
 * @returns {void}
 */
export function assertSelfTest() {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "server-migration-numbering-"),
  );
  try {
    const schemaDirectory = path.join(temporaryDirectory, "schema");
    mkdirSync(schemaDirectory, { recursive: true });
    const makeMigration = (
      id,
      fileNumber = id.match(NUMBER_PREFIX_PATTERN)[1],
    ) => {
      const file = path.join(
        schemaDirectory,
        `${fileNumber}_${id.split("_")[1]}.sql`,
      );
      writeFileSync(file, "-- self-test\n", "utf8");
      return { id, file };
    };
    const expectFailure = (name, migrations, expectedText) => {
      const problems = validateMigrations(migrations);
      if (!problems.some((problem) => problem.includes(expectedText))) {
        throw new Error(`${name} 自我檢查沒有被擋下：${problems.join("；")}`);
      }
    };

    expectFailure(
      "撞號",
      [makeMigration("001_one"), makeMigration("001_two")],
      "編號前綴重複",
    );
    expectFailure(
      "斷號",
      [makeMigration("001_one"), makeMigration("003_three")],
      "連續遞增",
    );
    expectFailure(
      "id/file 編號不一致",
      [makeMigration("001_one"), makeMigration("002_two", "003")],
      "id 與 file 編號不一致",
    );

    const correct = [makeMigration("001_one"), makeMigration("002_two")];
    const correctProblems = validateMigrations(correct);
    if (correctProblems.length > 0) {
      throw new Error(
        `完全正確的 migration 被誤判：${correctProblems.join("；")}`,
      );
    }

    console.log("✓ 自我檢查：撞號紅、斷號紅、id/file 編號不一致紅、完全正確綠");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function main() {
  assertSelfTest();

  const migrations = parseMigrationSource(
    readFileSync(MIGRATIONS_SOURCE, "utf8"),
    MIGRATIONS_SOURCE,
  );
  const problems = validateMigrations(migrations);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `✓ migration 編號閘門：${migrations.length} 筆，從 001 起連續、id/file 編號一致、檔案全部存在`,
  );
}

const invokedFile = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedFile === import.meta.url) main();
