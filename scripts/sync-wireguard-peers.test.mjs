import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchApprovedPeers,
  formatPlan,
  makePlan,
  parseCurrentPeerKeys,
  renderManagedConfig,
  validateApprovedPeers,
} from './sync-wireguard-peers.mjs';

const keyA = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const keyB = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const keyC = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';

function peer(publicKey, tunnelIp, label = '教務處-3F-NB01') {
  return {
    public_key: publicKey,
    tunnel_ip: tunnelIp,
    label,
    email: 'someone@example.gov.tw',
    asset_tag: 'NAER-2024-0173',
  };
}

function approved(peers, extra = {}) {
  return validateApprovedPeers({
    as_of: '2026-08-15T07:20:00Z',
    peers,
    ...extra,
  });
}

test('plans added, removed, and unchanged peers and renders /32 AllowedIPs', () => {
  const currentConfig = `[Interface]\nPrivateKey = secret\n\n[Peer]\nPublicKey = ${keyA}\nAllowedIPs = 10.99.0.10/32\n\n[Peer]\nPublicKey = ${keyB}\nAllowedIPs = 10.99.0.11/32\n`;
  const desired = approved([peer(keyB, '10.99.0.11'), peer(keyC, '10.99.0.12')]);

  const plan = makePlan(parseCurrentPeerKeys(currentConfig), desired.peers);
  assert.deepEqual(plan.added.map((item) => item.publicKey), [keyC]);
  assert.deepEqual(plan.removed, [keyA]);
  assert.deepEqual(plan.unchanged.map((item) => item.publicKey), [keyB]);

  const output = formatPlan(plan);
  assert.match(output, /會新增 \(1\)/);
  assert.match(output, /會移除 \(1\)/);
  assert.match(output, /不變 \(1\)/);

  const rendered = renderManagedConfig(currentConfig, desired);
  assert.doesNotMatch(rendered, new RegExp(keyA.replace(/[+]/g, '\\+')));
  assert.match(rendered, new RegExp(keyB.replace(/[+]/g, '\\+')));
  assert.match(rendered, new RegExp(keyC.replace(/[+]/g, '\\+')));
  assert.match(rendered, /AllowedIPs = 10\.99\.0\.11\/32/);
  assert.match(rendered, /AllowedIPs = 10\.99\.0\.12\/32/);
  assert.match(rendered, /# BEGIN exam-server managed WireGuard peers/);
  assert.match(rendered, /# END exam-server managed WireGuard peers/);
});

test('replaces only managed peer region after first migration and keeps Interface content', () => {
  const config = `[Interface]\nAddress = 10.99.0.1/24\nPrivateKey = secret\n\n# operator note stays\n\n[Peer]\nPublicKey = ${keyA}\nAllowedIPs = 10.99.0.10/32\n`;
  const rendered = renderManagedConfig(config, approved([peer(keyB, '10.99.0.11')]));
  assert.match(rendered, /^\[Interface\]/);
  assert.match(rendered, /Address = 10\.99\.0\.1\/24/);
  assert.match(rendered, /PrivateKey = secret/);
  assert.match(rendered, /# operator note stays/);
  assert.doesNotMatch(rendered, new RegExp(keyA));
  assert.match(rendered, new RegExp(keyB));
});

test('refuses an empty list unless upstream explicitly marks it authoritative', () => {
  assert.throws(
    () => approved([]),
    /refusing empty peer list without authoritative_empty=true/,
  );
  const value = approved([], { authoritative_empty: true });
  assert.deepEqual(value.peers, []);
});

test('rejects malformed upstream peer data before touching config', () => {
  assert.throws(
    () =>
      validateApprovedPeers({
        as_of: '2026-08-15T07:20:00Z',
        peers: [{ ...peer(keyA, '10.99.0.11'), public_key: 'not-a-key' }],
      }),
    /invalid public_key/,
  );
});

test('treats upstream HTTP failure as a hard failure', async () => {
  await assert.rejects(
    fetchApprovedPeers({
      baseUrl: 'https://control.example.test',
      token: 'test-token',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/,
  );
});
