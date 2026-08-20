#!/usr/bin/env node
/**
 * **`check-affair-scope.mjs` 的自我檢查。**
 *
 * ## 🔴 為什麼這支必須存在
 *
 * 2026-08-20 王陽明對第一版閘門做突變驗證，四格裡**兩格是綠的**（D3 移進子目錄、
 * D4 換檔名後綴）。那兩條繞道當時只被記在一份 review 的 result 檔裡
 * ——**沒有任何機械檢查在守它們**。
 *
 * ⚠️ `main` 上五支同類守門（`check-migration-numbering`、`sync-wireguard-peers`、
 * `wg-sync-contract-oracle`、`create-user`、`verify-baseref`）都有配對的 `test:*`；
 * 只有 affair 這支沒有。⇒ 這支就是補齊那一格。
 *
 * ## ⚠️ 為什麼用「把閘門複製進 fixture 樹」而不是加 `--root` 參數
 *
 * 閘門用 `import.meta.url` 往上一層算 `ROOT`。若為了可測而加
 * `--root` / `--max` 這類覆寫參數，就等於**在閘門上開一個旁路**
 * （有人可以在 `package.json` 裡把 `--max 99` 塞進去）。
 *
 * ⇒ 所以 fixture 是：`<tmp>/scripts/check-affair-scope.mjs`（原檔逐位元複製）
 *   ＋ `<tmp>/apps/api/src/…`。閘門自己算出來的 `ROOT` 就是 `<tmp>`，
 *   `MAX_AFFAIR_ROUTE_FILES` 仍然是原始碼裡那個 4。**零旁路。**
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "check-affair-scope.mjs");

/** 建一棵只有閘門要看的東西的假樹，回傳它的 exit code 與輸出。 */
function runWith(relativeFiles) {
  const root = mkdtempSync(path.join(tmpdir(), "affair-scope-"));
  try {
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    copyFileSync(GATE, path.join(root, "scripts", "check-affair-scope.mjs"));
    for (const rel of relativeFiles) {
      const full = path.join(root, "apps", "api", "src", rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, "export const noop = 1;\n");
    }
    const r = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "check-affair-scope.mjs")],
      { encoding: "utf8" },
    );
    return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 今天 repo 的真實形狀：四支、平鋪。 */
const BASELINE = [
  "affair-configuration-routes.ts",
  "affair-receipt-routes.ts",
  "affair-routes.ts",
  "affair-submission-routes.ts",
];

test("正向對照：剛好四支平鋪 ⇒ 綠", () => {
  const r = runWith([...BASELINE, "exams-routes.ts", "members-routes.ts"]);
  assert.equal(r.code, 0, `應該綠，實際 ${r.code}\n${r.err}`);
  assert.match(r.out, /4 個（上限 4）/u);
});

test("D1 多一支同形檔 ⇒ 紅", () => {
  const r = runWith([...BASELINE, "affair-extra-routes.ts"]);
  assert.equal(r.code, 1, "多一支必須紅");
  assert.match(r.err, /從 4 增加到 5/u);
});

test("D2 只剩三支而上限沒降 ⇒ 也要紅（否則棘輪鬆掉）", () => {
  const r = runWith(BASELINE.slice(0, 3));
  assert.equal(r.code, 1, "少一支而 MAX 沒降必須紅");
  assert.match(r.err, /已降到 3/u);
});

test("D3 移進子目錄、檔名不含 affair ⇒ 紅（第一版在這裡是綠的）", () => {
  const r = runWith([...BASELINE, path.join("affair", "routes.ts")]);
  assert.equal(r.code, 1, "子目錄繞道必須被抓到");
  assert.match(r.err, /從 4 增加到 5/u);
});

test("D4 換檔名後綴 ⇒ 紅（第一版在這裡是綠的）", () => {
  const r = runWith([...BASELINE, "affair-extra-handlers.ts"]);
  assert.equal(r.code, 1, "換後綴繞道必須被抓到");
  assert.match(r.err, /從 4 增加到 5/u);
});

test("⚠️ 誠實邊界：整支搬出 apps/api/src ⇒ 這道閘門看不到", () => {
  // 這一條**不是**在斷言正確行為，而是把「已知擋不住的那條路」寫成可執行的證據，
  // 免得它變成一句沒人驗的散文。要覆蓋它就另立一格閘門。
  const r = runWith(BASELINE);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /packages/u);
});

test("非 .ts 檔不計入（例如 SQL、md）", () => {
  const r = runWith([...BASELINE, "affair-notes.md", "affair-schema.sql"]);
  assert.equal(r.code, 0, `非 .ts 不該讓它紅\n${r.err}`);
  assert.match(r.out, /4 個（上限 4）/u);
});
