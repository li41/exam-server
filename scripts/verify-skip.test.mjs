import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  declareSkip,
  readLedger,
  renderReport,
  resetLedger,
} from "./verify-skip.mjs";

const withLedger = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-skip-"));
  const ledger = join(dir, "verify-skips.jsonl");
  try {
    return fn(ledger);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("declareSkip appends a machine-readable entry", () => {
  withLedger((ledger) => {
    resetLedger(ledger);
    declareSkip({ gate: "G", missing: "M", impact: "I" }, ledger);
    assert.deepEqual(readLedger(ledger).entries, [
      { gate: "G", missing: "M", impact: "I" },
    ]);
    assert.match(readFileSync(ledger, "utf8"), /"impact":"I"/u);
  });
});

test("declareSkip refuses an empty impact — 'skipped' alone is not information", () => {
  withLedger((ledger) => {
    resetLedger(ledger);
    for (const bad of [
      { gate: "", missing: "m", impact: "i" },
      { gate: "g", missing: "", impact: "i" },
      { gate: "g", missing: "m", impact: "" },
    ]) {
      assert.throws(() => declareSkip(bad, ledger));
    }
    assert.equal(readLedger(ledger).entries.length, 0);
  });
});

test("reset makes 'ledger has entries' mean 'this run skipped'", () => {
  withLedger((ledger) => {
    resetLedger(ledger);
    declareSkip({ gate: "G", missing: "M", impact: "I" }, ledger);
    resetLedger(ledger);
    assert.deepEqual(readLedger(ledger).entries, []);
    assert.equal(readLedger(ledger).present, true);
  });
});

test("a missing ledger is fail-closed, not 'no skips'", () => {
  withLedger((ledger) => {
    const report = renderReport(readLedger(ledger));
    assert.equal(report.exitCode, 1);
    assert.match(report.text, /ledger missing/u);
  });
});

test("malformed lines are surfaced, never silently dropped", () => {
  withLedger((ledger) => {
    writeFileSync(ledger, '{"gate":"G"}\nnot json\n', "utf8");
    const ledgerState = readLedger(ledger);
    assert.equal(ledgerState.entries.length, 0);
    assert.equal(ledgerState.malformed.length, 2);
    assert.equal(renderReport(ledgerState).exitCode, 1);
  });
});

test("report distinguishes 'ran everything' from 'skipped something'", () => {
  withLedger((ledger) => {
    resetLedger(ledger);
    const clean = renderReport(readLedger(ledger));
    assert.equal(clean.exitCode, 0);
    assert.match(clean.text, /actually ran/u);

    declareSkip(
      {
        gate: "N-1 migration rollback compatibility",
        missing: "ROLLBACK_BASE_REF",
        impact: "X",
      },
      ledger,
    );
    const dirty = renderReport(readLedger(ledger));
    // ⚠️ 有跳過**不會**讓 verify 紅（否則沒有 MySQL 的人全都跑不了），
    //    但輸出必須與「全部跑過」不同。
    assert.equal(dirty.exitCode, 0);
    assert.match(dirty.text, /DID NOT ACTUALLY CHECK/u);
    assert.match(dirty.text, /ROLLBACK_BASE_REF/u);
    assert.doesNotMatch(dirty.text, /actually ran/u);
  });
});

// ⚠️ 上面全部是純函式。純函式全綠 ≠ 真的有腳本在寫帳本 —— 把
//    `cold-boot-acceptance.mjs` 的 declareSkip 整段拿掉，上面 6 條照樣全過。
//    ⇒ 這一條真的 spawn 那支腳本，用假的 os-release 逼它走跳過路徑。
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

test("cold-boot acceptance really writes to the ledger when it skips", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-skip-e2e-"));
  try {
    const ledger = join(dir, "verify-skips.jsonl");
    const osRelease = join(dir, "os-release");
    // ⚠️ 假的 os-release ⇒ 在 AlmaLinux 上跑也一定走跳過路徑（這條不看機器）。
    writeFileSync(osRelease, 'ID="definitely-not-almalinux"\n', "utf8");
    const result = spawnSync(
      process.execPath,
      [resolve(SCRIPTS_DIR, "cold-boot-acceptance.mjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          VERIFY_SKIP_LEDGER: ledger,
          SERVER_FOUNDATION_OS_RELEASE_FILE: osRelease,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SKIP server-autostart/u);
    const entries = readLedger(ledger).entries;
    assert.equal(entries.length, 1, `ledger: ${JSON.stringify(entries)}`);
    assert.match(entries[0].gate, /cold-boot acceptance/u);
    // 7 項真機檢查名要逐項出現在 impact 裡，不可以只寫「跳過了」
    for (const name of ["server-autostart", "readiness", "loopback-trusted"]) {
      assert.ok(entries[0].impact.includes(name), entries[0].impact);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
