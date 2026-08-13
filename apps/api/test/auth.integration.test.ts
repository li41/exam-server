import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "redis";
import { Argon2PasswordHasher, AuthService } from "@server-foundation/auth";
import {
  createMySqlPool,
  MySqlItemRepository,
  MySqlUserRepository,
  runMigrations,
} from "@server-foundation/mysql-adapter";
import {
  RedisRateLimiter,
  RedisSessionStore,
} from "@server-foundation/redis-adapter";
import type { AuthTokenResponse } from "@server-foundation/api-contracts";
import { createApp } from "../src/app.js";

const mysqlUrl = process.env.MYSQL_TEST_URL;
const redisUrl = process.env.REDIS_TEST_URL;
const suite = mysqlUrl && redisUrl ? describe : describe.skip;

suite("authentication API with MySQL and Redis", () => {
  const pool = createMySqlPool(mysqlUrl as string);
  const redisClient = createClient({ url: redisUrl });
  const passwordHasher = new Argon2PasswordHasher();
  const users = new MySqlUserRepository(pool);
  const authenticationService = new AuthService({
    users,
    sessions: new RedisSessionStore(redisClient),
    passwordHasher,
    rateLimiter: new RedisRateLimiter(redisClient),
    loginRateLimit: { limit: 2, windowSeconds: 60 },
  });
  const app = createApp({
    itemRepository: new MySqlItemRepository(pool),
    authenticationService,
  });

  beforeAll(async () => {
    await runMigrations(pool);
    await redisClient.connect();
    await redisClient.flushDb();
    await pool.execute("DELETE FROM items");
    await pool.execute("DELETE FROM users");
    await users.create({
      userId: "api-auth-user-a",
      email: "auth-a@example.com",
      tenantId: "tenant-a",
      roles: ["owner"],
      passwordHash: await passwordHasher.hash("correct-a"),
    });
    await users.create({
      userId: "api-auth-user-b",
      email: "auth-b@example.com",
      tenantId: "tenant-b",
      roles: ["member"],
      passwordHash: await passwordHasher.hash("correct-b"),
    });
  });

  afterAll(async () => {
    await redisClient.flushDb();
    await redisClient.quit();
    await pool.end();
  });

  it("logs in, scopes items by tenant, rotates, and logs out", async () => {
    const loginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "AUTH-A@example.com",
        password: "correct-a",
      }),
    });
    expect(loginResponse.status).toBe(200);
    const firstTokens = (await loginResponse.json()) as AuthTokenResponse;

    const createResponse = await app.request("/api/items", {
      method: "POST",
      headers: {
        authorization: `Bearer ${firstTokens.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "tenant A item" }),
    });
    expect(createResponse.status).toBe(201);
    const item = await createResponse.json();
    expect(item.tenantId).toBe("tenant-a");

    const otherLoginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "auth-b@example.com",
        password: "correct-b",
      }),
    });
    const otherTokens = (await otherLoginResponse.json()) as AuthTokenResponse;
    const crossTenantResponse = await app.request(`/api/items/${item.id}`, {
      headers: { authorization: `Bearer ${otherTokens.accessToken}` },
    });
    expect(crossTenantResponse.status).toBe(404);

    const refreshResponse = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: firstTokens.refreshToken }),
    });
    expect(refreshResponse.status).toBe(200);
    const secondTokens = (await refreshResponse.json()) as AuthTokenResponse;
    expect(secondTokens.refreshToken).not.toBe(firstTokens.refreshToken);

    const oldAccessResponse = await app.request("/api/auth/me", {
      headers: { authorization: `Bearer ${firstTokens.accessToken}` },
    });
    expect(oldAccessResponse.status).toBe(401);

    const logoutResponse = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${secondTokens.accessToken}` },
    });
    expect(logoutResponse.status).toBe(204);
    const loggedOutResponse = await app.request("/api/auth/me", {
      headers: { authorization: `Bearer ${secondTokens.accessToken}` },
    });
    expect(loggedOutResponse.status).toBe(401);
  });

  it("rate-limits repeated invalid logins", async () => {
    const login = () =>
      app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "unknown@example.com",
          password: "wrong",
        }),
      });

    expect((await login()).status).toBe(401);
    expect((await login()).status).toBe(401);
    const limited = await login();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toEqual(expect.any(String));
  });
});
