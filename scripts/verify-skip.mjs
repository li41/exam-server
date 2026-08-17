/**
 * 「這一步沒有真的檢查」的宣告帳本。
 *
 * ## 為什麼 exam-server 是這個形狀（而不是像 exam-control 那樣改執行器）
 *
 * ⚠️ **exam-server 沒有 verify 執行器。** `package.json` 的 `verify` 是一條
 * `corepack pnpm a && corepack pnpm b && …` 的 shell chain（16 段）。所以：
 *
 * - 沒有逐步 exit code 表，沒有 `✓ / ✗ / 因 fail-fast 未執行` 三態摘要，
 *   ⇒ **沒有一個「摘要層」可以加第四態上去**。
 * - `&&` 只留下「整條過」或「停在某一段」；哪一段其實什麼都沒做，看不出來。
 *
 * `exam-control/scripts/verify.mjs` 與 `exam-runtime` 都有執行器，那邊的做法是
 * 讓子程序印一行標記、父程序把該步驟畫成 `⚠`。這裡沒有父程序可以收，所以改成
 * **落地帳本**：跳過的人寫一行 JSONL，鏈尾一支 report 把它們全部念出來。
 *
 * ⚠️ 代價（有意接受）：`&&` 是 fail-fast，中途紅掉時 report 不會執行 ——
 *    那時畫面上已經是紅的，不會有人誤讀成「全部驗過了」。
 *
 * ## 帳本
 *
 * - 位置：repo 根的 `verify-skips.jsonl`（已 gitignore）。
 * - `pnpm verify` 開頭 `--reset` 清空 ⇒ 「檔案裡有東西」永遠代表**這一次**有跳過。
 * - 每筆 `{ gate, missing, impact }`。⚠️ `impact` 必填：「跳過了」不是資訊，
 *   「沒驗到 N-1 回滾相容性」才是。
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** repo 根（本檔在 `scripts/` 底下）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 帳本路徑。⚠️ 必須與 `.gitignore` 的 `verify-skips.jsonl` 一致。
 *
 * ⚠️ `VERIFY_SKIP_LEDGER` 只是**測試用的注入點**：跳過路徑住在別的腳本裡
 * （`cold-boot-acceptance.mjs` 之類），沒有這個 env 就只能靠 mock 去驗，
 * 而 mock 驗不到「那支腳本真的有寫帳本」。`scripts/verify-skip.test.mjs`
 * 用它 spawn 真的 cold-boot 腳本並檢查帳本內容。
 */
export const LEDGER_PATH =
  process.env.VERIFY_SKIP_LEDGER?.trim() ||
  join(REPO_ROOT, "verify-skips.jsonl");

/**
 * 清空帳本（`pnpm verify` 的第一段）。
 *
 * ⚠️ 寫一個**空檔**而不是刪檔：`verify-skip-report.mjs` 用「檔案不存在」判斷
 *    「reset 沒跑過」並 fail closed —— 少了這個區分，把 reset 從鏈上拿掉會讓
 *    report 靜靜印「沒有跳過」，而那正是這支要消滅的形狀。
 *
 * @param {string} [ledgerPath]
 * @returns {void}
 */
export function resetLedger(ledgerPath = LEDGER_PATH) {
  writeFileSync(ledgerPath, "", "utf8");
}

/**
 * 宣告一項「跑了但沒有實際檢查」。
 *
 * @param {{ gate: string, missing: string, impact: string }} declaration
 * @param {string} [ledgerPath]
 * @returns {void}
 */
export function declareSkip(
  { gate, missing, impact },
  ledgerPath = LEDGER_PATH,
) {
  for (const [name, value] of Object.entries({ gate, missing, impact })) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `declareSkip requires a non-empty ${name} (got ${JSON.stringify(value)}).`,
      );
    }
  }
  console.log("");
  console.log(`⚠ SKIPPED: ${gate}`);
  console.log(`   missing: ${missing}`);
  console.log(`   NOT verified this run: ${impact}`);
  console.log("   This is not a pass.");
  console.log("");
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({ gate, missing, impact })}\n`,
    "utf8",
  );
}

/**
 * 讀回帳本。
 *
 * @param {string} [ledgerPath]
 * @returns {{ present: boolean, entries: { gate: string, missing: string, impact: string }[], malformed: string[] }}
 *   `present` 為 false 代表 reset 沒跑過（不是「沒有跳過」）。
 *   ⚠️ 壞掉的行進 `malformed` 而**不是**被丟掉 —— 靜默丟掉會退化成「全綠」。
 */
export function readLedger(ledgerPath = LEDGER_PATH) {
  if (!existsSync(ledgerPath))
    return { present: false, entries: [], malformed: [] };
  const entries = [];
  const malformed = [];
  for (const line of readFileSync(ledgerPath, "utf8").split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (
        typeof parsed?.gate !== "string" ||
        typeof parsed?.missing !== "string" ||
        typeof parsed?.impact !== "string"
      ) {
        malformed.push(line);
        continue;
      }
      entries.push({
        gate: parsed.gate,
        missing: parsed.missing,
        impact: parsed.impact,
      });
    } catch {
      malformed.push(line);
    }
  }
  return { present: true, entries, malformed };
}

/**
 * 鏈尾要印的那段報告。
 *
 * @param {{ present: boolean, entries: { gate: string, missing: string, impact: string }[], malformed: string[] }} ledger
 * @returns {{ text: string, exitCode: number }}
 */
export function renderReport(ledger) {
  const bar = "=".repeat(64);
  if (!ledger.present) {
    return {
      text:
        `${bar}\nverify skip report: ledger missing\n${bar}\n` +
        `  The ledger is created by \`pnpm gates:skip-reset\`, which \`pnpm verify\` runs first.\n` +
        `  Its absence means the chain was not run as a whole — refusing to report "no skips".\n`,
      exitCode: 1,
    };
  }
  if (ledger.malformed.length > 0) {
    return {
      text:
        `${bar}\nverify skip report: ${ledger.malformed.length} malformed ledger line(s)\n${bar}\n` +
        ledger.malformed.map((line) => `  ${line}\n`).join("") +
        `  A skip that cannot be read is worse than no skip at all.\n`,
      exitCode: 1,
    };
  }
  if (ledger.entries.length === 0) {
    return {
      text: "verify skip report: every gate in the chain actually ran.\n",
      exitCode: 0,
    };
  }
  const lines = [
    bar,
    `⚠ ${ledger.entries.length} gate(s) in this run DID NOT ACTUALLY CHECK ANYTHING`,
    bar,
  ];
  for (const entry of ledger.entries) {
    lines.push(`  ⚠ ${entry.gate}`);
    lines.push(`     missing: ${entry.missing}`);
    lines.push(`     not verified: ${entry.impact}`);
  }
  lines.push("");
  lines.push(
    '  ⇒ "verify passed" does not cover the items above. Report them as not verified.',
  );
  return { text: `${lines.join("\n")}\n`, exitCode: 0 };
}
