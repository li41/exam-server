import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSelfTest,
  parseMigrationSource,
  validateMigrations,
} from "./check-migration-numbering.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationSourcePath = path.join(
  root,
  "packages",
  "adapters",
  "mysql",
  "src",
  "migrate.ts",
);

const withFixture = (callback) => {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "server-migration-numbering-test-"),
  );
  try {
    const schemaDirectory = path.join(temporaryDirectory, "schema");
    mkdirSync(schemaDirectory, { recursive: true });
    const migration = (id, fileNumber = id.slice(0, 3)) => {
      const file = path.join(
        schemaDirectory,
        `${fileNumber}_${id.split("_")[1]}.sql`,
      );
      writeFileSync(file, "-- test\n", "utf8");
      return { id, file };
    };
    return callback({ migration, schemaDirectory });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

test("讀取真的 migrate.ts 陣列並通過四項檢查", () => {
  const migrations = parseMigrationSource(
    readFileSync(migrationSourcePath, "utf8"),
    migrationSourcePath,
  );
  assert.equal(migrations.length, 9);
  assert.deepEqual(validateMigrations(migrations), []);
});

test("抓到重複編號", () => {
  withFixture(({ migration }) => {
    const problems = validateMigrations([
      migration("001_one"),
      migration("001_two"),
    ]);
    assert.ok(problems.some((problem) => problem.includes("編號前綴重複")));
  });
});

test("抓到斷號", () => {
  withFixture(({ migration }) => {
    const problems = validateMigrations([
      migration("001_one"),
      migration("003_three"),
    ]);
    assert.ok(problems.some((problem) => problem.includes("連續遞增")));
  });
});

test("抓到 id 與 file 編號不一致", () => {
  withFixture(({ migration }) => {
    const problems = validateMigrations([
      migration("001_one"),
      migration("002_two", "003"),
    ]);
    assert.ok(
      problems.some((problem) => problem.includes("id 與 file 編號不一致")),
    );
  });
});

test("抓到 migration file 不存在", () => {
  withFixture(({ migration, schemaDirectory }) => {
    const missing = {
      id: "002_two",
      file: path.join(schemaDirectory, "002_two.sql"),
    };
    const problems = validateMigrations([migration("001_one"), missing]);
    assert.ok(
      problems.some((problem) => problem.includes("migration file 不存在")),
    );
  });
});

test("完全正確的 migration 陣列通過", () => {
  withFixture(({ migration }) => {
    assert.deepEqual(
      validateMigrations([migration("001_one"), migration("002_two")]),
      [],
    );
  });
});

test("閘門自我檢查包含三紅一綠", () => {
  assert.doesNotThrow(() => assertSelfTest());
});
