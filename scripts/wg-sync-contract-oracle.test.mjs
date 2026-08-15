import assert from "node:assert/strict";
import test from "node:test";

import {
  checkControlContractSources,
  runOracle,
} from "./wg-sync-contract-oracle.mjs";
import { fetchApprovedPeers } from "./sync-wireguard-peers.mjs";

const contractSource = `
export const WG_APPROVED_PEERS_PATH = "/api/wg/approved-peers";
export const WG_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
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
        contractSource: contractSource.replace("{43}=", "{42}=="),
        routeSource,
      }),
    /WG_PUBLIC_KEY_PATTERN drifted/u,
  );
});

test("fails when a control response field changes", () => {
  assert.throws(
    () =>
      checkControlContractSources({
        contractSource,
        routeSource: routeSource.replace("asset_tag", "inventory_tag"),
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
