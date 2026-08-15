#!/usr/bin/env node

import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MANAGED_BEGIN = '# BEGIN exam-server managed WireGuard peers';
const MANAGED_END = '# END exam-server managed WireGuard peers';
const WG_INTERFACE = 'wg0';
const DEFAULT_CONFIG = '/etc/wireguard/wg0.conf';

function fail(message) {
  throw new Error(message);
}

function oneLine(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function isValidPublicKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

function isValidIpv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function validateApprovedPeers(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('upstream response must be a JSON object');
  }
  if (typeof payload.as_of !== 'string' || Number.isNaN(Date.parse(payload.as_of))) {
    fail('upstream response has invalid as_of');
  }
  if (!Array.isArray(payload.peers)) fail('upstream response has invalid peers');

  if (payload.peers.length === 0 && payload.authoritative_empty !== true) {
    fail('refusing empty peer list without authoritative_empty=true');
  }

  const publicKeys = new Set();
  const tunnelIps = new Set();
  const peers = payload.peers.map((peer, index) => {
    if (!peer || typeof peer !== 'object' || Array.isArray(peer)) {
      fail(`peer ${index} must be an object`);
    }
    const { public_key: publicKey, tunnel_ip: tunnelIp, label, email, asset_tag: assetTag } = peer;
    if (!isValidPublicKey(publicKey)) fail(`peer ${index} has invalid public_key`);
    if (!isValidIpv4(tunnelIp)) fail(`peer ${index} has invalid tunnel_ip`);
    if (typeof label !== 'string' || !label.trim()) fail(`peer ${index} has invalid label`);
    if (typeof email !== 'string' || !email.trim()) fail(`peer ${index} has invalid email`);
    if (typeof assetTag !== 'string' || !assetTag.trim()) fail(`peer ${index} has invalid asset_tag`);
    if (publicKeys.has(publicKey)) fail(`duplicate public_key: ${publicKey}`);
    if (tunnelIps.has(tunnelIp)) fail(`duplicate tunnel_ip: ${tunnelIp}`);
    publicKeys.add(publicKey);
    tunnelIps.add(tunnelIp);
    return {
      publicKey,
      tunnelIp,
      label: oneLine(label),
      email: oneLine(email),
      assetTag: oneLine(assetTag),
    };
  });

  return { asOf: new Date(payload.as_of).toISOString(), peers };
}

export async function fetchApprovedPeers({ baseUrl, token, fetchImpl = fetch }) {
  if (!baseUrl) fail('CF_BASE is required');
  if (!token) fail('CF_TOKEN is required');
  const url = `${baseUrl.replace(/\/+$/, '')}/api/wg/approved-peers`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`failed to fetch approved peers: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`failed to fetch approved peers: HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail('failed to fetch approved peers: response is not valid JSON');
  }
  return validateApprovedPeers(payload);
}

function peerKeyFromBlock(block) {
  const match = block.match(/^PublicKey\s*=\s*(\S+)\s*$/m);
  return match?.[1] ?? null;
}

export function parseCurrentPeerKeys(config) {
  const keys = new Set();
  const blocks = config.split(/(?=^\[Peer\]\s*$)/m).slice(1);
  for (const block of blocks) {
    const key = peerKeyFromBlock(block);
    if (key) keys.add(key);
  }
  return keys;
}

export function makePlan(currentKeys, desiredPeers) {
  const desiredKeys = new Set(desiredPeers.map((peer) => peer.publicKey));
  const added = desiredPeers.filter((peer) => !currentKeys.has(peer.publicKey));
  const removed = [...currentKeys].filter((key) => !desiredKeys.has(key));
  const unchanged = desiredPeers.filter((peer) => currentKeys.has(peer.publicKey));
  return { added, removed, unchanged };
}

function formatPeer(peer, asOf) {
  return [
    `# synced=${asOf} tunnel_ip=${peer.tunnelIp} label=${peer.label} email=${peer.email} asset_tag=${peer.assetTag}`,
    '[Peer]',
    `PublicKey = ${peer.publicKey}`,
    `AllowedIPs = ${peer.tunnelIp}/32`,
  ].join('\n');
}

export function renderManagedConfig(config, approved) {
  const managedBody = approved.peers.map((peer) => formatPeer(peer, approved.asOf)).join('\n\n');
  const managed = `${MANAGED_BEGIN}\n${managedBody}${managedBody ? '\n' : ''}${MANAGED_END}`;

  const begin = config.indexOf(MANAGED_BEGIN);
  const end = config.indexOf(MANAGED_END);
  if ((begin >= 0) !== (end >= 0) || (begin >= 0 && end < begin)) {
    fail('wg0.conf has malformed managed peer markers');
  }
  if (begin >= 0) {
    return `${config.slice(0, begin)}${managed}${config.slice(end + MANAGED_END.length)}`;
  }

  const firstPeer = config.search(/^\[Peer\]\s*$/m);
  if (firstPeer >= 0) {
    const prefix = config.slice(0, firstPeer).trimEnd();
    return `${prefix}\n\n${managed}\n`;
  }
  return `${config.trimEnd()}\n\n${managed}\n`;
}

function displayPeer(peer) {
  return `${peer.tunnelIp} ${peer.label} <${peer.email}> asset=${peer.assetTag}`;
}

export function formatPlan(plan) {
  const lines = [];
  lines.push(`會新增 (${plan.added.length})`);
  lines.push(...(plan.added.length ? plan.added.map((peer) => `  + ${displayPeer(peer)}`) : ['  (無)']));
  lines.push(`會移除 (${plan.removed.length})`);
  lines.push(...(plan.removed.length ? plan.removed.map((key) => `  - ${key}`) : ['  (無)']));
  lines.push(`不變 (${plan.unchanged.length})`);
  lines.push(...(plan.unchanged.length ? plan.unchanged.map((peer) => `  = ${displayPeer(peer)}`) : ['  (無)']));
  return lines.join('\n');
}

async function atomicReplace(path, content, mode) {
  const temp = join(dirname(path), `.wg0.conf.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, content, { encoding: 'utf8', mode });
  await chmod(temp, mode);
  await rename(temp, path);
}

function syncRuntime() {
  const result = spawnSync('bash', ['-c', `wg syncconf ${WG_INTERFACE} <(wg-quick strip ${WG_INTERFACE})`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = oneLine(result.stderr || result.stdout || `exit ${result.status}`);
    fail(`wg syncconf failed: ${detail}`);
  }
}

export async function applyConfig({ configPath = DEFAULT_CONFIG, approved, dryRun = false }) {
  const original = await readFile(configPath, 'utf8');
  const currentKeys = parseCurrentPeerKeys(original);
  const plan = makePlan(currentKeys, approved.peers);
  const rendered = renderManagedConfig(original, approved);
  console.log(formatPlan(plan));
  if (dryRun) return plan;

  const originalStat = await stat(configPath);
  const mode = originalStat.mode & 0o777;
  await atomicReplace(configPath, rendered, mode);
  try {
    syncRuntime();
  } catch (error) {
    await atomicReplace(configPath, original, mode);
    try {
      syncRuntime();
    } catch {
      // The config file is already restored; preserve the original failure below.
    }
    throw error;
  }
  return plan;
}

function usage() {
  console.error('usage: CF_BASE=https://... CF_TOKEN=... node scripts/sync-wireguard-peers.mjs [--dry-run] [--config /etc/wireguard/wg0.conf]');
}

async function main() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let configPath = DEFAULT_CONFIG;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
    else {
      usage();
      process.exitCode = 2;
      return;
    }
  }

  const approved = await fetchApprovedPeers({ baseUrl: process.env.CF_BASE, token: process.env.CF_TOKEN });
  await applyConfig({ configPath, approved, dryRun });
  if (!dryRun) console.log(`applied ${approved.peers.length} peer(s) from ${approved.asOf}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
