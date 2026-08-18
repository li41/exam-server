import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { declareSkip } from "./verify-skip.mjs";

const execFileAsync = promisify(execFile);

export const acceptanceChecks = [
  "server-autostart",
  "readiness",
  "listener-boundary",
  "mysql-autostart",
  "valkey-autostart",
  "firewalld-enabled-active",
  "firewalld-boundary-rules",
  "loopback-trusted",
];

export function parseKeyValueFile(content) {
  const values = {};
  for (const rawLine of String(content).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function parseSsLocalListeners(output, port) {
  const suffix = `:${port}`;
  return String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/u))
    .filter((fields) => fields.length >= 5)
    .map((fields) => fields[3]) // ss local address is column 4; column 5 is peer address.
    .filter((localAddress) => localAddress.endsWith(suffix));
}

export function validateListenerBoundary(listeners, host, port) {
  if (["0.0.0.0", "::", "[::]", "*"].includes(host)) {
    throw new Error(`HOST must not be a wildcard listener: ${host}`);
  }
  const expected = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  if (listeners.length !== 1 || listeners[0] !== expected) {
    throw new Error(
      `expected ss column 4 to contain only ${expected}; got ${listeners.length ? listeners.join(", ") : "none"}`,
    );
  }
}

export function validateReadiness(payload) {
  if (!payload || payload.status !== "ok") {
    throw new Error(`readiness status is ${payload?.status ?? "missing"}`);
  }
  for (const name of ["mysql", "redis", "storage"]) {
    if (payload.checks?.[name]?.status !== "ok") {
      throw new Error(`readiness check ${name} is not ok`);
    }
  }
}

/** firewalld 停用期間改走 `KNOWN-DISABLED` 的三項。 */
export const FIREWALLD_CHECKS = new Set([
  "firewalld-enabled-active",
  "firewalld-boundary-rules",
  "loopback-trusted",
]);

export const FIREWALLD_DISABLED_REASON =
  "firewalld 已依 2026-08-16 裁示停用（它讓桌面版 listener 測試回 timeout 而非 ECONNREFUSED）";

export const RESTART_CONDITION =
  "scripts/cold-boot-acceptance.mjs 的 `firewalld 三項是條件式的` 註解";

export function formatSkipReport(reason) {
  return acceptanceChecks.map((name) => `SKIP ${name}: ${reason}`);
}

const command = async (program, args = []) => {
  try {
    const { stdout = "", stderr = "" } = await execFileAsync(program, args, {
      encoding: "utf8",
      timeout: 10_000,
    });
    return { stdout, stderr };
  } catch (error) {
    const detail = [error?.stdout, error?.stderr]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim())
      .join(" | ");
    throw new Error(
      `${program} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      { cause: error },
    );
  }
};

const printSkipAndExit = (reason) => {
  for (const line of formatSkipReport(reason)) console.log(line);
  // ⚠️ 逐項印 `SKIP <check>` 已經很誠實了 —— 但它 exit 0，而 `pnpm verify` 是
  //    一條 `&&` chain，**沒有摘要層**：跑完只看得到最後一段的輸出。
  //    ⇒ 這一格是本機 verify 上**唯一真的會走到跳過**的閘門（開發機不是
  //    AlmaLinux／systemd 不是 PID 1），卻和真的驗過長得一樣。
  //    寫進帳本，鏈尾 `gates:skip-report` 會把它連同 8 項檢查名一起念出來。
  declareSkip({
    gate: "cold-boot acceptance (real machine)",
    missing: reason,
    impact: acceptanceChecks.join(", "),
  });
};

const configValue = (config, name) => {
  const value = config[name]?.trim();
  if (!value) throw new Error(`${name} is missing from the service env file`);
  return value;
};

const fetchReadiness = async (host, port) => {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const response = await fetch(`http://${urlHost}:${port}/health/ready`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `GET /health/ready returned HTTP ${response.status}: ${body}`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error("GET /health/ready did not return JSON", { cause: error });
  }
  validateReadiness(payload);
};

export async function runAcceptance({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (platform !== "linux") {
    printSkipAndExit(`requires Linux/systemd; current platform=${platform}`);
    return { skipped: true, failures: 0 };
  }

  let pidOne;
  try {
    pidOne = (await command("ps", ["-p", "1", "-o", "comm="])).stdout.trim();
  } catch {
    pidOne = "unknown";
  }
  if (pidOne !== "systemd") {
    printSkipAndExit(`systemd is not PID 1 (got ${pidOne || "empty"})`);
    return { skipped: true, failures: 0 };
  }

  const osReleasePath =
    env.SERVER_FOUNDATION_OS_RELEASE_FILE ?? "/etc/os-release";
  let osRelease;
  try {
    osRelease = parseKeyValueFile(await readFile(osReleasePath, "utf8"));
  } catch (error) {
    printSkipAndExit(`cannot read ${osReleasePath}: ${error.message}`);
    return { skipped: true, failures: 0 };
  }
  if (osRelease.ID !== "almalinux") {
    printSkipAndExit(
      `real cold-boot acceptance requires AlmaLinux; current ID=${osRelease.ID ?? "unknown"}`,
    );
    return { skipped: true, failures: 0 };
  }

  const envFile =
    env.SERVER_FOUNDATION_ENV_FILE ??
    "/etc/server-foundation/server-foundation.env";
  const config = parseKeyValueFile(await readFile(envFile, "utf8"));
  const host = configValue(config, "HOST");
  const port = configValue(config, "PORT");
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`PORT is invalid in ${envFile}: ${port}`);
  }

  const service = env.SERVER_FOUNDATION_SERVICE ?? "server-foundation";
  const mysqlService = env.SERVER_FOUNDATION_MYSQL_SERVICE ?? "mysqld";
  const valkeyService = env.SERVER_FOUNDATION_VALKEY_SERVICE ?? "valkey";
  const wireGuardInterface = env.SERVER_FOUNDATION_WG_INTERFACE ?? "wg0";
  const wireGuardPort = env.SERVER_FOUNDATION_WG_PORT ?? "51820";

  /**
   * ⚠️⚠️ **firewalld 三項是「條件式」的，不是無條件跳過。**
   *
   * 2026-08-16 主公裁示停用這台的 firewalld，理由是它會卡住桌面版的開發：
   * 兩台 WSL 走 mirrored（共用網路），firewalld 一啟動就讓「剛釋放的 loopback 埠」
   * 回 timeout 而不是 ECONNREFUSED，`exam-admin-desktop` 的 `listener_policy.rs`
   * 六發必紅、cargo test 從 0.4 秒拖到 135 秒。
   * ⚠️ 在 firewalld 裡開洞**無效**（試過 loopback direct ACCEPT 與 raw NOTRACK 都沒用）
   *    ⇒ 真正在擋的很可能是 Windows 側的 Hyper-V 防火牆，Linux 這邊只是觸發者。
   *
   * ## 🔁 重啟條件（做到任一項就把 firewalld 開回來）
   *
   * 1. Windows 側確認並放行：
   *    `Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore`
   *    若 `DefaultInboundAction` 是 `Block` ⇒ 改成 `Allow`。
   * 2. 或這台不再與桌面版共用網路（例如改回 NAT 模式）。
   *
   * 然後：`sudo systemctl enable --now firewalld`
   *
   * ## ⚠️ 為什麼是「偵測」而不是「寫死跳過」
   *
   * 寫死跳過的話，**防火牆開回來之後這三項會繼續是空的** —— 那才是最危險的：
   * 看起來有檢查、實際上什麼都不驗。
   * ⇒ 這裡**每次執行都去問 firewalld 現在是不是 active**：
   *    · active   ⇒ 三項照常驗（PASS／FAIL）
   *    · inactive ⇒ 印 `KNOWN-DISABLED`，不計為失敗，但**每次都把重啟條件印出來**
   */
  let firewalldActive = true;
  try {
    await command("systemctl", ["is-active", "--quiet", "firewalld"]);
  } catch {
    firewalldActive = false;
  }

  const checks = [
    [
      "server-autostart",
      async () => command("systemctl", ["is-enabled", "--quiet", service]),
    ],
    ["readiness", async () => fetchReadiness(host, port)],
    [
      "listener-boundary",
      async () => {
        const { stdout } = await command("ss", ["-H", "-ltnp"]);
        const listeners = parseSsLocalListeners(stdout, port);
        validateListenerBoundary(listeners, host, port);
      },
    ],
    [
      "mysql-autostart",
      async () => command("systemctl", ["is-enabled", "--quiet", mysqlService]),
    ],
    [
      "valkey-autostart",
      async () =>
        command("systemctl", ["is-enabled", "--quiet", valkeyService]),
    ],
    [
      "firewalld-enabled-active",
      async () => {
        await command("systemctl", ["is-enabled", "--quiet", "firewalld"]);
        await command("systemctl", ["is-active", "--quiet", "firewalld"]);
      },
    ],
    [
      "firewalld-boundary-rules",
      async () => {
        await command("firewall-cmd", [`--query-port=${wireGuardPort}/udp`]);
        await command("firewall-cmd", [
          "--zone=trusted",
          `--query-interface=${wireGuardInterface}`,
        ]);
        await command("firewall-cmd", [
          "--zone=trusted",
          `--query-port=${port}/tcp`,
        ]);
      },
    ],
    [
      "loopback-trusted",
      async () => {
        await command("firewall-cmd", [
          "--zone=trusted",
          "--query-interface=lo",
        ]);
        await command("firewall-cmd", [
          "--zone=trusted",
          "--query-source=127.0.0.0/8",
        ]);
      },
    ],
  ];

  let failures = 0;
  let knownDisabled = 0;
  for (const [name, check] of checks) {
    if (!firewalldActive && FIREWALLD_CHECKS.has(name)) {
      knownDisabled += 1;
      console.log(`KNOWN-DISABLED ${name}: ${FIREWALLD_DISABLED_REASON}`);
      continue;
    }
    try {
      await check();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.error(
        `FAIL ${name}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  if (knownDisabled > 0) {
    // ⚠️ 每次都印，不讓它變成沒人看得見的背景狀態。
    console.log(
      `KNOWN-DISABLED 共 ${knownDisabled} 項 —— 重啟條件見 ${RESTART_CONDITION}`,
    );
  }

  return { skipped: false, failures, knownDisabled };
}

const main = async () => {
  const result = await runAcceptance();
  if (result.failures > 0) process.exitCode = 1;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
