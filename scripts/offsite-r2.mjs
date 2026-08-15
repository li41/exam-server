import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";

export const DEFAULT_R2_ENV_FILE =
  "/etc/server-foundation/offsite-backup.env";
export const DEFAULT_APP_ENV_FILE =
  "/etc/server-foundation/server-foundation.env";
export const DEFAULT_RETENTION_COUNT = 30;
export const DEFAULT_R2_PREFIX = "server-foundation/backups";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const R2_KEYS = new Set([
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_PREFIX",
]);

const fail = (message) => {
  throw new Error(message);
};

export const parseDataEnv = (content) => {
  const values = {};
  for (const [index, rawLine] of String(content).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) fail(`env line ${index + 1} must be KEY=VALUE`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      fail(`env line ${index + 1} has invalid key: ${key}`);
    }
    if (Object.hasOwn(values, key)) fail(`env file has duplicate ${key}`);
    values[key] = value;
  }
  return values;
};

const requireValue = (values, key) => {
  const value = values[key];
  if (typeof value !== "string" || value === "" || value === "CHANGE_ME") {
    fail(`${key} must be configured`);
  }
  return value;
};

const normalizePrefix = (value) => {
  const prefix = String(value || DEFAULT_R2_PREFIX)
    .replace(/^\/+|\/+$/gu, "")
    .trim();
  if (!prefix || prefix.split("/").some((part) => !part || part === "..")) {
    fail("R2_PREFIX must be a safe non-empty object prefix");
  }
  return prefix;
};

export const loadR2Config = async (path = DEFAULT_R2_ENV_FILE) => {
  const values = parseDataEnv(await readFile(path, "utf8"));
  for (const key of Object.keys(values)) {
    if (!R2_KEYS.has(key)) fail(`unsupported R2 credential key: ${key}`);
  }
  const accountId = requireValue(values, "R2_ACCOUNT_ID");
  const bucket = requireValue(values, "R2_BUCKET");
  const accessKeyId = requireValue(values, "R2_ACCESS_KEY_ID");
  const secretAccessKey = requireValue(values, "R2_SECRET_ACCESS_KEY");
  if (!/^[A-Za-z0-9]+$/u.test(accountId)) fail("R2_ACCOUNT_ID is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,62}$/u.test(bucket)) {
    fail("R2_BUCKET is invalid");
  }
  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix: normalizePrefix(values.R2_PREFIX),
  };
};

export const loadBackupAppConfig = async (path = DEFAULT_APP_ENV_FILE) => {
  const values = parseDataEnv(await readFile(path, "utf8"));
  return {
    mysqlUrl: requireValue(values, "MYSQL_URL"),
    storageRoot: requireValue(values, "FILE_STORAGE_ROOT"),
    backupRoot: requireValue(values, "BACKUP_ROOT"),
  };
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value, encoding) =>
  createHmac("sha256", key).update(value).digest(encoding);
const awsEncode = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/gu, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const canonicalPath = (bucket, key = "") =>
  `/${awsEncode(bucket)}${
    key ? `/${key.split("/").map(awsEncode).join("/")}` : ""
  }`;
const canonicalQuery = (entries) =>
  [...entries]
    .map(([key, value]) => [awsEncode(String(key)), awsEncode(String(value))])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue.localeCompare(rightValue)
        : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
const amzTimestamp = (now) =>
  now.toISOString().replace(/[:-]|\.\d{3}/gu, "");

export const signR2Request = ({
  method,
  host,
  path,
  queryEntries = [],
  headers = {},
  payloadHash = EMPTY_SHA256,
  accessKeyId,
  secretAccessKey,
  now = new Date(),
}) => {
  const timestamp = amzTimestamp(now);
  const date = timestamp.slice(0, 8);
  const normalizedHeaders = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
  };
  for (const [name, value] of Object.entries(headers)) {
    normalizedHeaders[name.toLowerCase()] = String(value).trim();
  }
  const signedHeaderNames = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${normalizedHeaders[name].replace(/\s+/gu, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const query = canonicalQuery(queryEntries);
  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  return {
    query,
    headers: {
      ...normalizedHeaders,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
};

const xmlDecode = (value) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
const xmlTag = (xml, name) => {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u"));
  return match ? xmlDecode(match[1]) : null;
};

export const parseListObjectsXml = (xml) => {
  const objects = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
    const key = xmlTag(match[1], "Key");
    const lastModified = xmlTag(match[1], "LastModified");
    if (!key || !lastModified || Number.isNaN(Date.parse(lastModified))) {
      fail("R2 list response contains an invalid object entry");
    }
    objects.push({
      key: decodeURIComponent(key),
      lastModified: new Date(lastModified).toISOString(),
    });
  }
  return {
    objects,
    isTruncated: xmlTag(xml, "IsTruncated") === "true",
    nextContinuationToken: xmlTag(xml, "NextContinuationToken"),
  };
};

const responseDetail = async (response) => {
  const text = await response.text().catch(() => "");
  return text.replace(/\s+/gu, " ").trim().slice(0, 300);
};

export const createR2Client = (config, { fetchImpl = fetch } = {}) => {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const endpoint = `https://${host}`;

  const request = async ({
    method,
    key = "",
    queryEntries = [],
    payloadHash = EMPTY_SHA256,
    headers = {},
    body,
  }) => {
    const path = canonicalPath(config.bucket, key);
    const signed = signR2Request({
      method,
      host,
      path,
      queryEntries,
      headers,
      payloadHash,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    const url = `${endpoint}${path}${signed.query ? `?${signed.query}` : ""}`;
    const response = await fetchImpl(url, {
      method,
      headers: signed.headers,
      ...(body ? { body, duplex: "half" } : {}),
    });
    if (!response.ok) {
      const detail = await responseDetail(response);
      fail(
        `R2 ${method} failed with HTTP ${response.status}${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    return response;
  };

  return {
    async putObject(key, filePath) {
      const fileStat = await stat(filePath);
      const payloadHash = await sha256File(filePath);
      const response = await request({
        method: "PUT",
        key,
        payloadHash,
        headers: {
          "content-length": fileStat.size,
          "content-type": "application/gzip",
          "x-amz-meta-sha256": payloadHash,
        },
        body: createReadStream(filePath),
      });
      await response.arrayBuffer();
      return { sha256: payloadHash };
    },

    async getObjectToFile(key, destinationPath) {
      const response = await request({ method: "GET", key });
      const expectedSha256 = response.headers.get("x-amz-meta-sha256");
      if (!expectedSha256 || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
        fail(`R2 object ${key} is missing x-amz-meta-sha256`);
      }
      if (!response.body) fail(`R2 object ${key} has no body`);
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      try {
        await pipeline(
          Readable.fromWeb(response.body),
          createWriteStream(destinationPath, { mode: 0o600 }),
        );
        const actualSha256 = await sha256File(destinationPath);
        if (actualSha256 !== expectedSha256) {
          fail(`R2 object ${key} checksum mismatch`);
        }
        return { sha256: actualSha256 };
      } catch (error) {
        await rm(destinationPath, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async listObjects(prefix = config.prefix) {
      const objects = [];
      let continuationToken = null;
      do {
        const queryEntries = [
          ["encoding-type", "url"],
          ["list-type", "2"],
          ["prefix", `${prefix}/`],
        ];
        if (continuationToken) {
          queryEntries.push(["continuation-token", continuationToken]);
        }
        const response = await request({ method: "GET", queryEntries });
        const page = parseListObjectsXml(await response.text());
        objects.push(...page.objects);
        continuationToken = page.isTruncated
          ? page.nextContinuationToken ||
            fail("R2 list was truncated without a continuation token")
          : null;
      } while (continuationToken);
      return objects;
    },

    async deleteObject(key) {
      const response = await request({ method: "DELETE", key });
      await response.arrayBuffer();
    },
  };
};

export const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const run = (command, args) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(`${command} exited with code ${code ?? "unknown"}`),
        );
    });
  });

const assertBackupName = (name) => {
  if (!/^backup-[A-Za-z0-9._-]+$/u.test(name)) {
    fail(`invalid backup directory name: ${name}`);
  }
  return name;
};

export const objectKeyForBackup = (prefix, backupDirectory) =>
  `${normalizePrefix(prefix)}/${assertBackupName(
    basename(resolve(backupDirectory)),
  )}.tar.gz`;

export const createBackupArchive = async ({ backupDirectory, workRoot }) => {
  const source = resolve(backupDirectory);
  const name = assertBackupName(basename(source));
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const archivePath = join(resolve(workRoot), `${name}.tar.gz`);
  await run("tar", ["-C", dirname(source), "-czf", archivePath, name]);
  return { archivePath, sha256: await sha256File(archivePath) };
};

export const extractBackupArchive = async ({ archivePath, workRoot }) => {
  const destination = resolve(workRoot);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await run("tar", [
    "-C",
    destination,
    "-xzf",
    resolve(archivePath),
    "--no-same-owner",
    "--no-same-permissions",
  ]);
  const entries = (await readdir(destination, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("backup-"),
  );
  if (entries.length !== 1) {
    fail("off-site archive must contain exactly one backup directory");
  }
  return join(destination, assertBackupName(entries[0].name));
};

const backupObject = (object, prefix) => {
  const normalizedPrefix = `${normalizePrefix(prefix)}/`;
  if (!object.key.startsWith(normalizedPrefix)) return null;
  const name = object.key.slice(normalizedPrefix.length);
  if (!/^backup-[A-Za-z0-9._-]+\.tar\.gz$/u.test(name)) return null;
  const timestamp = Date.parse(object.lastModified);
  if (Number.isNaN(timestamp)) fail(`invalid R2 LastModified for ${object.key}`);
  return { ...object, timestamp };
};

export const buildRetentionPlan = (
  objects,
  { prefix = DEFAULT_R2_PREFIX, keepCount = DEFAULT_RETENTION_COUNT } = {},
) => {
  if (!Number.isSafeInteger(keepCount) || keepCount < 1) {
    fail("retention keepCount must be at least 1");
  }
  const backups = objects
    .map((object) => backupObject(object, prefix))
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp || left.key.localeCompare(right.key),
    );
  return {
    keep: backups.slice(0, keepCount),
    delete: backups.slice(keepCount),
  };
};

export const formatRetentionPlan = (plan) => {
  const lines = [`會保留 (${plan.keep.length})`];
  if (plan.keep.length === 0) lines.push("  (無)");
  else {
    lines.push(
      ...plan.keep.map(
        (object) => `  KEEP ${object.lastModified} ${object.key}`,
      ),
    );
  }
  lines.push(`會刪除 (${plan.delete.length})`);
  if (plan.delete.length === 0) lines.push("  (無)");
  else {
    lines.push(
      ...plan.delete.map(
        (object) => `  DELETE ${object.lastModified} ${object.key}`,
      ),
    );
  }
  return lines.join("\n");
};

export const applyRetention = async ({
  client,
  prefix,
  keepCount = DEFAULT_RETENTION_COUNT,
  dryRun = false,
  output = console.log,
}) => {
  const objects = await client.listObjects(prefix);
  const plan = buildRetentionPlan(objects, { prefix, keepCount });
  output(formatRetentionPlan(plan));
  if (!dryRun) {
    for (const object of plan.delete) await client.deleteObject(object.key);
  }
  return plan;
};
