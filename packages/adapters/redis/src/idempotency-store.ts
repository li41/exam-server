import { createHash } from "node:crypto";
import type {
  IdempotencyReservation,
  IdempotencyStore,
  IdempotencyStoredResponse,
} from "@server-foundation/domain";
import type { RedisClientType } from "redis";

type RedisIdempotencyClient = RedisClientType;

type StoredEntry = {
  state: "pending" | "completed";
  requestHash: string;
  response?: IdempotencyStoredResponse;
};

type ReservationPayload = {
  state?: IdempotencyReservation["state"];
  response?: IdempotencyStoredResponse;
};

const redisKey = (scope: string, key: string): string => {
  const digest = createHash("sha256")
    .update(scope)
    .update("\0")
    .update(key)
    .digest("hex");
  return `server-foundation:idempotency:${digest}`;
};

const reserveScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[2])
  return '{"state":"acquired"}'
end
local current = cjson.decode(raw)
if current.requestHash ~= ARGV[1] then
  return '{"state":"conflict"}'
end
if current.state == 'completed' then
  return raw
end
return '{"state":"pending"}'
`;

const completeScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.requestHash ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[2])
return 1
`;

const releaseScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.state == 'pending' and current.requestHash == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const parseReservation = (raw: unknown): IdempotencyReservation => {
  if (typeof raw !== "string") {
    throw new Error("Redis returned an invalid idempotency reservation.");
  }
  const parsed = JSON.parse(raw) as ReservationPayload;
  if (
    parsed.state === "acquired" ||
    parsed.state === "pending" ||
    parsed.state === "conflict"
  ) {
    return { state: parsed.state };
  }
  if (
    parsed.state === "completed" &&
    parsed.response &&
    typeof parsed.response.status === "number" &&
    typeof parsed.response.body === "string"
  ) {
    return { state: "completed", response: parsed.response };
  }
  throw new Error("Redis returned an invalid idempotency entry.");
};

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: RedisIdempotencyClient) {}

  async reserve(
    scope: string,
    key: string,
    requestHash: string,
    ttlSeconds: number,
  ): Promise<IdempotencyReservation> {
    const pending: StoredEntry = { state: "pending", requestHash };
    const result = await this.client.eval(reserveScript, {
      keys: [redisKey(scope, key)],
      arguments: [requestHash, String(ttlSeconds), JSON.stringify(pending)],
    });
    return parseReservation(result);
  }

  async complete(
    scope: string,
    key: string,
    requestHash: string,
    response: IdempotencyStoredResponse,
    ttlSeconds: number,
  ): Promise<void> {
    const completed: StoredEntry = {
      state: "completed",
      requestHash,
      response,
    };
    await this.client.eval(completeScript, {
      keys: [redisKey(scope, key)],
      arguments: [requestHash, String(ttlSeconds), JSON.stringify(completed)],
    });
  }

  async release(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<void> {
    await this.client.eval(releaseScript, {
      keys: [redisKey(scope, key)],
      arguments: [requestHash],
    });
  }
}
