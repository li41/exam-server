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
  // ⚠️ 刻意**從解析結果自身推導**筆數,⛔ 不硬編、⛔ 不掃 schema 目錄。
  //    原本寫 `assert.equal(migrations.length, 9)`,affairs stack 進 main 後變 14 就紅了 ——
  //    而它紅得沒有意義:沒有任何東西壞掉,只是有人正常加了 migration。
  //    ⛔ 不改成「比對 schema/ 的 .sql 檔數」—— `check-migration-numbering.mjs` 的檔頭明寫
  //       「真相源是 migrate.ts,不掃 schema 檔名」,那樣寫會違反該模組刻意的設計。
  //    ⇒ 保留原本的保護意圖（解析真的抓到一份完整清單）:筆數必須等於最後一筆的編號。
  //       解析截斷或漏抓中間任一筆,這條就紅。
  assert.ok(migrations.length > 0, "解析不到任何 migration,這條測試在守空氣");
  const lastNumber = Number(migrations.at(-1).id.match(/^(\d+)_/)[1]);
  assert.equal(migrations.length, lastNumber);
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
