/**
 * `pnpm verify` 的頭尾兩段：`--reset` 清帳本，無參數印報告。
 *
 * 用法（package.json）：
 * - `gates:skip-reset`  → `node scripts/verify-skip-report.mjs --reset`
 * - `gates:skip-report` → `node scripts/verify-skip-report.mjs`
 *
 * ⚠️ 報告本身**不因為有跳過而 exit 1** —— 缺 `ROLLBACK_BASE_REF` 就紅會讓
 *    每一個沒有 MySQL 的人都跑不了 verify。它只保證「沒跑到」與「通過」
 *    在輸出上長得不一樣。帳本讀不到才 exit 1（那是機制壞掉，不是缺件）。
 */

import process from "node:process";
import { readLedger, renderReport, resetLedger } from "./verify-skip.mjs";

if (process.argv.includes("--reset")) {
  resetLedger();
  console.log("verify skip ledger reset.");
  process.exit(0);
}

const { text, exitCode } = renderReport(readLedger());
process.stdout.write(text);
process.exit(exitCode);
