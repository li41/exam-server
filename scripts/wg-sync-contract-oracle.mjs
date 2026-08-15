#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateApprovedPeers } from "./sync-wireguard-peers.mjs";

const CONTROL_CONTRACT_PATH = "packages/desktop-contracts/src/wire/index.ts";
const CONTROL_ROUTE_PATH = "src/routes/wg-approved-peers.ts";
const EXPECTED_PATH = "/api/wg/approved-peers";
const EXPECTED_PUBLIC_KEY_PATTERN = "/^[A-Za-z0-9+/]{43}=$/";
const EXPECTED_RESPONSE_FIELDS = [
  "as_of",
  "authoritative_empty",
  "peers",
  "public_key",
  "tunnel_ip",
  "label",
  "email",
  "asset_tag",
];
const SAMPLE_PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function fail(message) {
  throw new Error(message);
}

function extractStringConstant(source, name) {
  const pattern = new RegExp(
    `\\b${name}\\b\\s*(?::[^=;]+)?=\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`,
    "u",
  );
  const match = source.match(pattern);
  if (!match)
    fail(`control contract does not define ${name} as a string constant`);
  return match[2];
}

function extractStatement(source, name) {
  // ⚠️ 一定要錨在 `export const <name>` 這個**宣告**上，不能抓「第一次出現的名字」。
  //    control 的契約檔在真正宣告之前，文件註解裡就先提到過 `WG_PUBLIC_KEY_PATTERN`
  //    （一張說明表格）⇒ 抓第一次出現會抓到註解片段，然後**無條件報 drift**。
  //    2026-08-15 這支第一次跑就是這樣假紅的；探針錯了比沒有探針更花時間。
  const start = source.search(new RegExp(`export\\s+const\\s+${name}\\b`, "u"));
  if (start < 0) fail(`control contract does not define ${name}`);
  const semicolon = source.indexOf(";", start);
  const newline = source.indexOf("\n", start);
  const end = semicolon >= 0 ? semicolon + 1 : newline;
  return source.slice(start, end >= 0 ? end : undefined);
}

export function checkControlContractSources({ contractSource, routeSource }) {
  const path = extractStringConstant(contractSource, "WG_APPROVED_PEERS_PATH");
  if (path !== EXPECTED_PATH) {
    fail(`control path drifted: expected ${EXPECTED_PATH}, got ${path}`);
  }

  const keyPatternStatement = extractStatement(
    contractSource,
    "WG_PUBLIC_KEY_PATTERN",
  );
  if (!keyPatternStatement.includes(EXPECTED_PUBLIC_KEY_PATTERN)) {
    fail(
      "control WG_PUBLIC_KEY_PATTERN drifted; review it against the server consumer validator",
    );
  }

  if (!/\bWG_APPROVED_PEERS_PATH\b/u.test(routeSource)) {
    fail("control route no longer references WG_APPROVED_PEERS_PATH");
  }
  // ⚠️ 欄位名要對**契約 schema**查，不是對路由檔查。
  //    control 的路由只組 `{ as_of, authoritative_empty, peers }`，
  //    peer 的五個欄位來自 repository 並交給 `WgApprovedPeersResponseSchema` 驗，
  //    路由原始碼裡根本不會出現 `public_key` 這些字。
  //    2026-08-15 這支第一次跑就對著路由檔找 `public_key` 而假紅。
  const peerSchema = extractStatement(contractSource, "WgApprovedPeerSchema");
  const responseSchema = extractStatement(
    contractSource,
    "WgApprovedPeersResponseSchema",
  );
  const schemaSource = `${peerSchema}\n${responseSchema}`;
  for (const field of EXPECTED_RESPONSE_FIELDS) {
    if (!new RegExp(`\\b${field}\\b`, "u").test(schemaSource)) {
      fail(`control response schema is missing expected field: ${field}`);
    }
  }

  validateApprovedPeers({
    as_of: "2026-08-15T00:00:00Z",
    authoritative_empty: false,
    peers: [
      {
        public_key: SAMPLE_PUBLIC_KEY,
        tunnel_ip: "10.99.0.10",
        label: "oracle",
        email: "oracle@example.invalid",
        asset_tag: "ORACLE-1",
      },
    ],
  });

  return { path, fields: [...EXPECTED_RESPONSE_FIELDS] };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  let controlRoot = process.env.EXAM_CONTROL_ROOT?.trim() || "";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--control-root" && argv[index + 1]) {
      controlRoot = argv[++index];
    } else {
      fail(
        "usage: node wg-sync-contract-oracle.mjs [--control-root ../exam-control]",
      );
    }
  }
  return { controlRoot };
}

export async function runOracle(
  { controlRoot = "" } = {},
  { readFileImpl = readFile, log = console.log } = {},
) {
  const root = resolve(controlRoot || "../exam-control");
  const contractPath = resolve(root, CONTROL_CONTRACT_PATH);
  const routePath = resolve(root, CONTROL_ROUTE_PATH);

  if (!(await exists(contractPath)) || !(await exists(routePath))) {
    log(
      `SKIP wg-control-contract: true exam-control checkout not available at ${root}; set EXAM_CONTROL_ROOT or --control-root to run the cross-repo oracle`,
    );
    return { skipped: true, root };
  }

  const [contractSource, routeSource] = await Promise.all([
    readFileImpl(contractPath, "utf8"),
    readFileImpl(routePath, "utf8"),
  ]);
  const result = checkControlContractSources({ contractSource, routeSource });
  log(
    `PASS wg-control-contract: ${result.path} matches server consumer contract`,
  );
  return { skipped: false, root, ...result };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (invokedPath === import.meta.url) {
  runOracle(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(
      `FAIL wg-control-contract: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
