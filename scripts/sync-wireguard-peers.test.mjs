import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fetchApprovedPeers,
  formatPlan,
  loadCredentials,
  makePlan,
  parseCredentialFile,
  parseCurrentPeerKeys,
  renderManagedConfig,
  validateApprovedPeers,
} from "./sync-wireguard-peers.mjs";

const keyA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const keyB = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const keyC = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";

function peer(publicKey, tunnelIp, label = "教務處-3F-NB01") {
  return {
    public_key: publicKey,
    tunnel_ip: tunnelIp,
    label,
    email: "someone@example.gov.tw",
    asset_tag: "NAER-2024-0173",
  };
}

function approved(peers, extra = {}) {
  return validateApprovedPeers({
    as_of: "2026-08-15T07:20:00Z",
    peers,
    ...extra,
  });
}

test("plans added, removed, and unchanged peers and renders /32 AllowedIPs", () => {
  const currentConfig = `[Interface]\nPrivateKey = secret\n\n[Peer]\nPublicKey = ${keyA}\nAllowedIPs = 10.99.0.10/32\n\n[Peer]\nPublicKey = ${keyB}\nAllowedIPs = 10.99.0.11/32\n`;
  const desired = approved([
    peer(keyB, "10.99.0.11"),
    peer(keyC, "10.99.0.12"),
  ]);

  const plan = makePlan(parseCurrentPeerKeys(currentConfig), desired.peers);
  assert.deepEqual(
    plan.added.map((item) => item.publicKey),
    [keyC],
  );
  assert.deepEqual(plan.removed, [keyA]);
  assert.deepEqual(
    plan.unchanged.map((item) => item.publicKey),
    [keyB],
  );

  const output = formatPlan(plan);
  assert.match(output, /會新增 \(1\)/);
  assert.match(output, /會移除 \(1\)/);
  assert.match(output, /不變 \(1\)/);

  const rendered = renderManagedConfig(currentConfig, desired);
  assert.doesNotMatch(rendered, new RegExp(keyA.replace(/[+]/g, "\\+")));
  assert.match(rendered, new RegExp(keyB.replace(/[+]/g, "\\+")));
  assert.match(rendered, new RegExp(keyC.replace(/[+]/g, "\\+")));
  assert.match(rendered, /AllowedIPs = 10\.99\.0\.11\/32/);
  assert.match(rendered, /AllowedIPs = 10\.99\.0\.12\/32/);
  assert.match(rendered, /# BEGIN exam-server managed WireGuard peers/);
  assert.match(rendered, /# END exam-server managed WireGuard peers/);
});

test("replaces only managed peer region after first migration and keeps Interface content", () => {
  const config = `[Interface]\nAddress = 10.99.0.1/24\nPrivateKey = secret\n\n# operator note stays\n\n[Peer]\nPublicKey = ${keyA}\nAllowedIPs = 10.99.0.10/32\n`;
  const rendered = renderManagedConfig(
    config,
    approved([peer(keyB, "10.99.0.11")]),
  );
  assert.match(rendered, /^\[Interface\]/);
  assert.match(rendered, /Address = 10\.99\.0\.1\/24/);
  assert.match(rendered, /PrivateKey = secret/);
  assert.match(rendered, /# operator note stays/);
  assert.doesNotMatch(rendered, new RegExp(keyA));
  assert.match(rendered, new RegExp(keyB));
});

test("refuses an empty list unless upstream explicitly marks it authoritative", () => {
  assert.throws(
    () => approved([]),
    /refusing empty peer list without authoritative_empty=true/,
  );
  const value = approved([], { authoritative_empty: true });
  assert.deepEqual(value.peers, []);
});

test("rejects malformed upstream peer data before touching config", () => {
  assert.throws(
    () =>
      validateApprovedPeers({
        as_of: "2026-08-15T07:20:00Z",
        peers: [{ ...peer(keyA, "10.99.0.11"), public_key: "not-a-key" }],
      }),
    /invalid public_key/,
  );
});

test("treats upstream HTTP failure as a hard failure", async () => {
  await assert.rejects(
    fetchApprovedPeers({
      baseUrl: "https://control.example.test",
      token: "test-token",
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/,
  );
});

test("loads CF credentials from a file without putting the token in argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wg-sync-credentials-"));
  const envFile = join(directory, "wireguard-peer-sync.env");
  try {
    await writeFile(
      envFile,
      "# root-only credential file\nCF_BASE=https://control.example.test\nCF_TOKEN=test-secret-token\n",
      { mode: 0o600 },
    );
    assert.deepEqual(await loadCredentials({ env: {}, envFile }), {
      baseUrl: "https://control.example.test",
      token: "test-secret-token",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential parser is data-only and rejects unexpected keys", () => {
  assert.deepEqual(
    parseCredentialFile(
      "CF_BASE=https://control.example.test\nCF_TOKEN=a=b=c\n",
    ),
    {
      CF_BASE: "https://control.example.test",
      CF_TOKEN: "a=b=c",
    },
  );
  assert.throws(
    () => parseCredentialFile("CF_TOKEN=x\nRUN_THIS=touch /tmp/pwned\n"),
    /unsupported key/,
  );
});

test("refuses the bootstrap placeholder token before contacting CF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wg-sync-placeholder-"));
  const envFile = join(directory, "wireguard-peer-sync.env");
  try {
    await writeFile(
      envFile,
      "CF_BASE=https://control.example.test\nCF_TOKEN=CHANGE_ME\n",
    );
    await assert.rejects(
      loadCredentials({ env: {}, envFile }),
      /CF_TOKEN is still CHANGE_ME/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap installs a root-only credential file once and documents the manual flow", async () => {
  const bootstrap = await readFile(
    new URL("../deploy/scripts/bootstrap-almalinux10.sh", import.meta.url),
    "utf8",
  );
  const start = bootstrap.indexOf('step "步驟 7b：WireGuard peer 同步器"');
  const end = bootstrap.indexOf('step "步驟 8：防火牆', start);
  assert.ok(
    start >= 0 && end > start,
    "expected a dedicated WireGuard sync install block",
  );
  const installBlock = bootstrap.slice(start, end);

  assert.match(installBlock, /sudo install -m 0755 -o root -g root/);
  assert.match(installBlock, /sync-wireguard-peers\.mjs" "\$WG_SYNC_BIN"/);
  assert.match(installBlock, /if ! sudo test -f "\$WG_SYNC_ENV_FILE"; then/);
  assert.match(
    installBlock,
    /sudo install -m 0600 -o root -g root \/dev\/null "\$WG_SYNC_ENV_FILE"/,
  );
  assert.match(installBlock, /CF_TOKEN=CHANGE_ME/);
  assert.match(installBlock, /已存在，保留既有 CF_TOKEN/);
  assert.match(installBlock, /sudo chmod 0600 "\$WG_SYNC_ENV_FILE"/);
  assert.match(installBlock, /sudo chown root:root "\$WG_SYNC_ENV_FILE"/);

  const createPosition = installBlock.indexOf("CF_TOKEN=CHANGE_ME");
  const preservePosition = installBlock.indexOf("已存在，保留既有 CF_TOKEN");
  assert.ok(createPosition >= 0 && preservePosition > createPosition);
  assert.doesNotMatch(
    installBlock.slice(preservePosition),
    /cat > .*WG_SYNC_ENV_FILE/,
  );

  assert.match(bootstrap, /sudo \$\{WG_SYNC_BIN\} --dry-run/);
  assert.match(bootstrap, /只要「會移除」不是 0/);
  assert.match(bootstrap, /fail closed，不改 wg0\.conf/);
});
