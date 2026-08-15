const DEFAULT_PREFIX = "server-foundation/backups";
const BACKUP_FILE = /^backup-[A-Za-z0-9._-]+\.tar\.gz$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const failResponse = (status, message) =>
  new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const normalizePrefix = (value) => {
  const prefix = String(value || DEFAULT_PREFIX)
    .replace(/^\/+|\/+$/gu, "")
    .trim();
  if (!prefix || prefix.split("/").some((part) => !part || part === "..")) {
    throw new Error("BACKUP_PREFIX must be a safe non-empty object prefix");
  }
  return prefix;
};

const timingSafeEqual = (left, right) => {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(String(left));
  const rightBytes = encoder.encode(String(right));
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
};

const authorized = (request, env) => {
  const expected = String(env.UPLOAD_TOKEN || "");
  if (!expected) throw new Error("UPLOAD_TOKEN is not configured");
  const header = request.headers.get("authorization") || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
};

export const validateBackupKey = (key, prefix = DEFAULT_PREFIX) => {
  const normalizedPrefix = normalizePrefix(prefix);
  const expectedPrefix = `${normalizedPrefix}/`;
  if (!key.startsWith(expectedPrefix)) {
    throw new Error("backup key is outside the configured prefix");
  }
  const name = key.slice(expectedPrefix.length);
  if (!BACKUP_FILE.test(name)) throw new Error("backup key has invalid name");
  return key;
};

const parseParts = async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new Error("completion body must be JSON");
  }
  if (!body || !Array.isArray(body.parts) || body.parts.length < 1) {
    throw new Error("completion body must contain parts");
  }
  if (body.parts.length > 10_000) throw new Error("too many upload parts");
  const seen = new Set();
  return body.parts.map((part) => {
    if (
      !part ||
      !Number.isSafeInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > 10_000 ||
      typeof part.etag !== "string" ||
      !part.etag
    ) {
      throw new Error("completion body contains an invalid part");
    }
    if (seen.has(part.partNumber)) throw new Error("duplicate upload part");
    seen.add(part.partNumber);
    return { partNumber: part.partNumber, etag: part.etag };
  });
};

export const handleRequest = async (request, env) => {
  if (!authorized(request, env)) return failResponse(401, "unauthorized");

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  if (action === "probe" && request.method === "POST") {
    return new Response(null, { status: 204 });
  }

  if (request.method !== "POST" && request.method !== "PUT") {
    return failResponse(405, "method not allowed");
  }

  const key = url.searchParams.get("key");
  if (!key) return failResponse(400, "missing backup key");
  try {
    validateBackupKey(key, env.BACKUP_PREFIX);
  } catch (error) {
    return failResponse(
      400,
      error instanceof Error ? error.message : "invalid key",
    );
  }

  if (request.method === "POST" && action === "mpu-create") {
    const checksum = request.headers.get("x-backup-sha256") || "";
    if (!SHA256.test(checksum)) {
      return failResponse(400, "invalid backup checksum");
    }
    if (await env.BACKUP_BUCKET.head(key)) {
      return failResponse(409, "backup key already exists");
    }
    const upload = await env.BACKUP_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { sha256: checksum },
    });
    return Response.json({ key: upload.key, uploadId: upload.uploadId });
  }

  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) return failResponse(400, "missing uploadId");
  const upload = env.BACKUP_BUCKET.resumeMultipartUpload(key, uploadId);

  if (request.method === "PUT" && action === "mpu-uploadpart") {
    const partNumber = Number(url.searchParams.get("partNumber"));
    if (
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > 10_000
    ) {
      return failResponse(400, "invalid partNumber");
    }
    if (!request.body) return failResponse(400, "missing request body");
    const uploaded = await upload.uploadPart(partNumber, request.body);
    return Response.json(uploaded);
  }

  if (request.method === "POST" && action === "mpu-complete") {
    try {
      const parts = await parseParts(request);
      const object = await upload.complete(parts);
      return new Response(null, {
        status: 204,
        headers: { etag: object.httpEtag },
      });
    } catch (error) {
      return failResponse(
        400,
        error instanceof Error ? error.message : "invalid completion",
      );
    }
  }

  return failResponse(400, "unsupported upload action");
};

export default {
  fetch: handleRequest,
};
