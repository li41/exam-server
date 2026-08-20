#!/usr/bin/env node
/**
 * **試務（affair）路由棘輪：只准變少。**
 *
 * 裁示（2026-08-19）：**試務整條屬於 CF（`exam-control`）**，不在這個 repo。
 * 理由與查證見 `doc/decision-affair-belongs-to-cf.md`。
 *
 * ## ⚠️ 為什麼是閘門而不是只寫一份文件
 *
 * 本專案 2026-08-19 一天內發現四次「把不變式的維持責任交給人的記憶」而失效的實例
 * （共用 worktree 沒人負責前進、登記表若只是散文、誰用哪棵 checkout、
 * 「等 X 成立再做 Y」寫在一個已合併的 Draft PR 內文裡）。
 *
 * 🔴 **散文會過期而不會紅。** ⇒ 這道閘門的存在理由就是「文件不足以防止重犯」。
 *
 * ## ⚠️ 判準刻意是「棘輪」而不是「必須為 0」
 *
 * 那四個檔今天**還在**（刪除等 `#80` 的逐檔清點輸出）。
 * ⇒ 若判準寫「必須為 0」，它今天就是紅的 ⇒ ⛔ 會立刻被關掉或放寬，而那比沒有閘門更糟。
 *
 * ⇒ 所以：**現有的允許存在、新增的擋下**。而 `MAX` 這一行的 diff 會逼審的人看見
 * 「試務債變多了」——⛔ 不要把它改大來讓自己通過。
 *
 * ## ⛔ 不要把上限寫成 `files.length`
 *
 * 那是同義反覆、永遠成立，等於沒有棘輪。（同 `exam-admin-desktop` 的
 * `check-contracts-link.mjs` 檔頭那條警語。）
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES_DIR = path.join(ROOT, "apps", "api", "src");

/**
 * ⚠️⚠️ **為什麼是遞迴 ＋ 寬鬆比對，而不是 `^affair.*-routes\.ts$` 加 `readdirSync` 一層。**
 *
 * 2026-08-20 王陽明對第一版做突變驗證，四格裡有**兩格是綠的**——也就是兩條可以
 * 靜默繞過的路：
 *
 * | 突變 | 第一版 | 現在 |
 * | --- | --- | --- |
 * | D1 多一支 `affair-x-routes.ts` | 🔴 紅（對） | 🔴 紅 |
 * | D2 刪到 3 支、`MAX` 不動 | 🔴 紅（對） | 🔴 紅 |
 * | **D3 移進子目錄** `affair/routes.ts` | ⚠️ **綠** | 🔴 紅 |
 * | **D4 換後綴** `affair-x-handlers.ts` | ⚠️ **綠** | 🔴 紅 |
 *
 * D3 的成因是 `readdirSync` **不遞迴**；D4 的成因是名字被綁死在 `-routes.ts`。
 * 🔴 兩者都是「新增試務程式碼而閘門不叫」——正是這道閘門唯一要防的事。
 *
 * ⇒ 現在的母體是：`apps/api/src` **底下任何深度**、**相對路徑**含 `affair`（不分大小寫）
 *   的 `.ts` 檔。⚠️ 比對路徑而非檔名，否則 `affair/routes.ts` 這種「目錄叫 affair、
 *   檔名不含 affair」的形狀會漏掉。⚠️ 刻意比「路由」寬——依裁示，這個 repo 不該有**任何**新的試務程式碼，
 *   ⛔ 不是「不該有新的試務路由」。
 *
 * ## ⚠️ 這道閘門**擋不住**什麼（不要以為它全包）
 *
 * 檔案整支搬出 `apps/api/src`（例如搬到 `packages/domain/src/use-cases/`）它**看不到**。
 * 全 repo 現有 47 個含 `affair` 的檔（2026-08-20 實測），要把整個表面都上棘輪是另一件事。
 * ⇒ ⛔ 不要在這裡假裝已經覆蓋；要覆蓋就另立一格並把 47 這個基線量過再寫。
 */
function listAffairSourceFiles(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listAffairSourceFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    // ⚠️ 比對的是**相對路徑**而不是 basename —— 否則 `affair/routes.ts`
    //    （目錄叫 affair、檔名不含 affair）會漏掉，而那正是 D3 那條繞道。
    const rel = path.relative(ROUTES_DIR, full);
    if (!/affair/i.test(rel)) continue;
    found.push(rel);
  }
  return found;
}

/**
 * ⚠️ 2026-08-19 實測的基線。**只准往下改。**
 *
 * 目前這四個（全部待刪、`#80` 清點中）：
 *   affair-configuration-routes.ts  affair-receipt-routes.ts
 *   affair-routes.ts                affair-submission-routes.ts
 */
const MAX_AFFAIR_ROUTE_FILES = 4;

const files = listAffairSourceFiles(ROUTES_DIR).sort();

console.log(
  `  試務程式檔（apps/api/src 遞迴、路徑含 affair 的 .ts）：${files.length} 個（上限 ${MAX_AFFAIR_ROUTE_FILES}）`,
);
for (const f of files) console.log(`    ${f}`);

let failed = false;

if (files.length > MAX_AFFAIR_ROUTE_FILES) {
  failed = true;
  console.error(
    `✗ 試務路由檔從 ${MAX_AFFAIR_ROUTE_FILES} 增加到 ${files.length} —— ` +
      `試務整條屬於 CF（exam-control），這個 repo 的 affair 路由是待刪的孤島。`,
  );
  console.error(`  ⇒ 理由與查證：doc/decision-affair-belongs-to-cf.md`);
  console.error(
    `  ⛔ 不要改大 MAX_AFFAIR_ROUTE_FILES 來通過 —— 要新增請先推翻那份裁示。`,
  );
}

/**
 * ⚠️ 對照組：基線降下來之後，`MAX` 沒跟著降 ⇒ 也要紅。
 *
 * 🔴 少了這一條，刪掉檔案之後棘輪就**鬆掉**了（上限停在 4，於是可以再加回來 3 個而不紅）
 * ⇒ 那正是「登記表過期而靜默存在」的同一個病。
 */
if (files.length < MAX_AFFAIR_ROUTE_FILES) {
  failed = true;
  console.error(
    `✗ 試務路由檔已降到 ${files.length}，但 MAX_AFFAIR_ROUTE_FILES 還是 ${MAX_AFFAIR_ROUTE_FILES}` +
      ` —— 請把上限一起降到 ${files.length}，否則棘輪鬆掉。`,
  );
}

if (failed) process.exit(1);
console.log(
  "✓ 試務路由棘輪：沒有新增（試務屬於 CF，見 doc/decision-affair-belongs-to-cf.md）",
);
