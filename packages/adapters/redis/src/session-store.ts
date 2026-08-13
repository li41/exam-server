import type {
  AuthSession,
  CreateSessionInput,
  RotateSessionInput,
  SessionStore,
  RateLimitResult,
  RateLimiter,
} from "@server-foundation/domain";
import type { RedisClientType } from "redis";

type RedisSessionClient = RedisClientType;

const secondsUntil = (iso: string): number =>
  Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));

const sessionKey = (id: string) => `server-foundation:session:${id}`;
const accessKey = (hash: string) => `server-foundation:access:${hash}`;
const refreshKey = (hash: string) => `server-foundation:refresh:${hash}`;
const revokedKey = (id: string) => `server-foundation:revoked:${id}`;

const serializeSession = (session: AuthSession): string =>
  JSON.stringify(session);

const parseSession = (value: string | null): AuthSession | null => {
  if (!value) return null;
  try {
    const session = JSON.parse(value) as AuthSession;
    if (
      typeof session.sessionId !== "string" ||
      typeof session.currentAccessTokenHash !== "string" ||
      typeof session.accessTokenExpiresAt !== "string" ||
      typeof session.refreshTokenExpiresAt !== "string" ||
      !session.identity
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
};

const rotateScript = `
local sessionId = redis.call('GET', KEYS[1])
if not sessionId then return false end
local revoked = 'server-foundation:revoked:' .. sessionId
local sessionKey = 'server-foundation:session:' .. sessionId
if redis.call('EXISTS', revoked) == 1 then
  redis.call('DEL', KEYS[1])
  return false
end
local rawSession = redis.call('GET', sessionKey)
if not rawSession then
  redis.call('DEL', KEYS[1])
  return false
end
local ttl = redis.call('TTL', sessionKey)
if ttl < 1 then
  redis.call('DEL', KEYS[1])
  return false
end
local session = cjson.decode(rawSession)
local oldAccessKey = 'server-foundation:access:' .. session.currentAccessTokenHash
session.currentAccessTokenHash = ARGV[3]
session.accessTokenExpiresAt = ARGV[2]
redis.call('SET', sessionKey, cjson.encode(session), 'KEEPTTL')
redis.call('DEL', oldAccessKey)
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], sessionId, 'EX', ARGV[1])
redis.call('SET', KEYS[3], sessionId, 'EX', ttl)
return cjson.encode(session)
`;

const revokeScript = `
local sessionId = redis.call('GET', KEYS[1])
if not sessionId then return false end
local ttl = redis.call('TTL', KEYS[2])
if ttl < 1 then return false end
redis.call('SET', KEYS[3], '1', 'EX', ttl)
return true
`;

const rateLimitScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
return { count, ttl }
`;

export class RedisSessionStore implements SessionStore {
  constructor(private readonly client: RedisSessionClient) {}

  async create(input: CreateSessionInput): Promise<void> {
    const session: AuthSession = {
      sessionId: input.sessionId,
      identity: input.identity,
      currentAccessTokenHash: input.accessTokenHash,
      createdAt: input.createdAt,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    };
    const ttl = secondsUntil(session.refreshTokenExpiresAt);
    await this.client
      .multi()
      .set(sessionKey(session.sessionId), serializeSession(session), {
        EX: ttl,
      })
      .set(accessKey(input.accessTokenHash), session.sessionId, {
        EX: secondsUntil(session.accessTokenExpiresAt),
      })
      .set(refreshKey(input.refreshTokenHash), session.sessionId, { EX: ttl })
      .exec();
  }

  async findByAccessTokenHash(hash: string): Promise<AuthSession | null> {
    const id = await this.client.get(accessKey(hash));
    if (!id) return null;
    if (await this.client.exists(revokedKey(id))) return null;
    return parseSession(await this.client.get(sessionKey(id)));
  }

  async rotate(input: RotateSessionInput): Promise<AuthSession | null> {
    const result = await this.client.eval(rotateScript, {
      keys: [
        refreshKey(input.refreshTokenHash),
        accessKey(input.newAccessTokenHash),
        refreshKey(input.newRefreshTokenHash),
      ],
      arguments: [
        String(input.newAccessTokenTtlSeconds),
        input.newAccessTokenExpiresAt,
        input.newAccessTokenHash,
      ],
    });
    if (typeof result !== "string") return null;
    return parseSession(result);
  }

  async revokeByAccessTokenHash(hash: string): Promise<void> {
    const id = await this.client.get(accessKey(hash));
    if (!id) return;
    await this.client.eval(revokeScript, {
      keys: [accessKey(hash), sessionKey(id), revokedKey(id)],
      arguments: [],
    });
  }
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly client: RedisSessionClient) {}

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const result = await this.client.eval(rateLimitScript, {
      keys: [`server-foundation:rate-limit:${key}`],
      arguments: [String(windowSeconds)],
    });
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error("Redis returned an invalid rate-limit result.");
    }
    const count = Number(result[0]);
    const ttl = Math.max(1, Number(result[1]));
    return {
      allowed: count <= limit,
      retryAfterSeconds: ttl,
    };
  }
}
