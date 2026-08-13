import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import type {
  AuthIdentity,
  CreateSessionInput,
} from "@server-foundation/domain";
import { RedisRateLimiter, RedisSessionStore } from "../src/index.js";

const connectionString = process.env.REDIS_TEST_URL;
const suite = connectionString ? describe : describe.skip;

suite("RedisSessionStore", () => {
  const client = createClient({ url: connectionString });
  const store = new RedisSessionStore(client);
  const limiter = new RedisRateLimiter(client);
  const identity: AuthIdentity = {
    userId: "redis-test-user",
    email: "redis-test@example.com",
    tenantId: "redis-test-tenant",
    roles: ["member"],
  };

  it("stores, atomically rotates, and revokes a session", async () => {
    await client.connect();
    await client.flushDb();

    const now = Date.now();
    const input: CreateSessionInput = {
      sessionId: randomUUID(),
      identity,
      currentAccessTokenHash: "access-old",
      accessTokenHash: "access-old",
      refreshTokenHash: "refresh-old",
      createdAt: new Date(now).toISOString(),
      accessTokenExpiresAt: new Date(now + 60_000).toISOString(),
      refreshTokenExpiresAt: new Date(now + 300_000).toISOString(),
    };
    await store.create(input);

    await expect(
      store.findByAccessTokenHash("access-old"),
    ).resolves.toMatchObject({ sessionId: input.sessionId });

    const rotated = await store.rotate({
      refreshTokenHash: "refresh-old",
      newAccessTokenHash: "access-new",
      newAccessTokenTtlSeconds: 60,
      newAccessTokenExpiresAt: new Date(now + 120_000).toISOString(),
      newRefreshTokenHash: "refresh-new",
    });
    expect(rotated).toMatchObject({
      sessionId: input.sessionId,
      currentAccessTokenHash: "access-new",
    });
    await expect(store.findByAccessTokenHash("access-old")).resolves.toBeNull();
    await expect(
      store.findByAccessTokenHash("access-new"),
    ).resolves.toMatchObject({ sessionId: input.sessionId });
    await expect(
      store.rotate({
        refreshTokenHash: "refresh-old",
        newAccessTokenHash: "access-second",
        newAccessTokenTtlSeconds: 60,
        newAccessTokenExpiresAt: new Date(now + 180_000).toISOString(),
        newRefreshTokenHash: "refresh-second",
      }),
    ).resolves.toBeNull();

    await store.revokeByAccessTokenHash("access-new");
    await expect(store.findByAccessTokenHash("access-new")).resolves.toBeNull();

    await expect(limiter.consume("login:test", 2, 60)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(limiter.consume("login:test", 2, 60)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(limiter.consume("login:test", 2, 60)).resolves.toMatchObject({
      allowed: false,
    });

    await client.flushDb();
    await client.quit();
  });
});
