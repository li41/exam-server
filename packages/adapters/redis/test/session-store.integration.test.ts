/**
 * ⚠️⚠️ **這個資料夾裡的整合測試不可以平行跑。**
 *
 * 本檔與同資料夾其他 `*.integration.test.ts` **共用同一個 `REDIS_TEST_URL`**，
 * 而且每個檔都會 `flushDb()` 洗掉整個 DB。vitest 預設平行跑檔案 ⇒
 * **後 flush 的會把先跑那個的 key 洗掉**，失敗的一方隨機。
 *
 * 2026-08-14：這個競態讓 CI 從 08-13 起一直紅，而且因為
 * `test:integration` 第一個失敗就停，**後面的 API 整合、N-1 migration 閘門、
 * 備份還原演練三道全部被跳過**——是「一條 flaky 測試擋掉三道關卡」。
 *
 * ⇒ `package.json` 的 `test:integration` 因此釘著 **`--no-file-parallelism`**。
 * ⚠️ **不要拿掉那個旗標**，也不要改用會平行的跑法。
 *
 * ⚠️ **要新增第三個整合測試檔的人請注意**：只要你也 `flushDb()`，
 * 這個約束就同樣適用。**更穩健的做法是不要 `flushDb()`，改成只清自己的 key 前綴**——
 * 那樣就不必依賴這個旗標。
 */
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
