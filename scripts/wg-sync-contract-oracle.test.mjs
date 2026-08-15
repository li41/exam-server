import assert from "node:assert/strict";
import test from "node:test";

import {
  checkControlContractSources,
  runOracle,
} from "./wg-sync-contract-oracle.mjs";
import { fetchApprovedPeers } from "./sync-wireguard-peers.mjs";

// ⚠️ 這份 fixture 刻意複製真檔的兩個特徵，否則測試會綠而真檔會紅（2026-08-15 實際發生過）：
//   1. **宣告之前的文件註解就先提到這些名字** —— 抽取器若抓「第一次出現」會抓到註解。
//   2. **peer 的欄位在 schema 上，不在路由檔上** —— 對路由檔找 `public_key` 一定找不到。
const contractSource = `
/**
 * | \`public_key\` 必須 \`/^[A-Za-z0-9+/]{43}=$/\` | \`WG_PUBLIC_KEY_PATTERN\`(同一個 regex) |
 * 這一段是註解,不是宣告。WgApprovedPeerSchema / WgApprovedPeersResponseSchema 也在這裡先被提到。
 */
export const WG_APPROVED_PEERS_PATH = "/api/wg/approved-peers";
export const WG_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
export const WgApprovedPeerSchema = v.object({
  public_key: v.pipe(v.string(), v.regex(WG_PUBLIC_KEY_PATTERN)),
  tunnel_ip: wgPeerIpv4,
  label: nonBlankPeerField(100),
  email: nonBlankPeerField(320),
  asset_tag: nonBlankPeerField(60),
});
export const WgApprovedPeersResponseSchema = v.object({
  as_of: v.pipe(v.string(), v.isoTimestamp()),
  authoritative_empty: v.boolean(),
  peers: v.array(WgApprovedPeerSchema),
});
`;

const routeSource = `
import { WG_APPROVED_PEERS_PATH } from "../packages/desktop-contracts/src/wire/index";
router.get(WG_APPROVED_PEERS_PATH, async () => ({
  as_of: new Date().toISOString(),
  authoritative_empty: false,
  peers: approved.map((peer) => ({
    public_key: peer.publicKey,
    tunnel_ip: peer.tunnelIp,
    label: peer.label,
    email: peer.email,
    asset_tag: peer.assetTag,
  })),
}));
`;

test("accepts the current documented exam-control source shape", () => {
  const result = checkControlContractSources({ contractSource, routeSource });
  assert.equal(result.path, "/api/wg/approved-peers");
  assert.ok(result.fields.includes("public_key"));
});

test("fails when the control path changes", () => {
  assert.throws(
    () =>
      checkControlContractSources({
        contractSource: contractSource.replace(
          "/api/wg/approved-peers",
          "/api/wg/peers-v2",
        ),
        routeSource,
      }),
    /control path drifted/u,
  );
});

test("fails when the control public-key contract changes", () => {
  assert.throws(
    () =>
      checkControlContractSources({
        // ⚠️ 用 replaceAll —— 單數 replace 只換第一個，而第一個在**註解**裡，
        //    宣告不會被改到，測試就會假綠。這正是本輪修掉的那個陷阱。
        contractSource: contractSource.replaceAll("{43}=", "{42}=="),
        routeSource,
      }),
    /WG_PUBLIC_KEY_PATTERN drifted/u,
  );
});

test("fails when a control response field changes", () => {
  assert.throws(
    () =>
      checkControlContractSources({
        // ⚠️ 欄位改名要改在 **schema** 上 —— 那才是欄位真正被定義的地方。
        //    改路由檔不會紅,因為路由檔本來就不含這些欄位名。
        contractSource: contractSource.replaceAll("asset_tag", "inventory_tag"),
        routeSource,
      }),
    /missing expected field: asset_tag/u,
  );
});

test("missing real exam-control checkout is an explicit SKIP", async () => {
  const lines = [];
  const result = await runOracle(
    { controlRoot: "/definitely/not/a/real/exam-control" },
    { log: (line) => lines.push(line) },
  );
  assert.equal(result.skipped, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^SKIP wg-control-contract:/u);
});

test("401 names the token mismatch without leaking the token", async () => {
  const secret = "secret-token-must-never-appear";
  await assert.rejects(
    fetchApprovedPeers({
      baseUrl: "https://control.example.test",
      token: secret,
      fetchImpl: async () => ({ ok: false, status: 401 }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 401/u);
      assert.match(error.message, /exam-control WG_SYNC_TOKEN/u);
      assert.match(error.message, /exam-server CF_TOKEN/u);
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      return true;
    },
  );
});
