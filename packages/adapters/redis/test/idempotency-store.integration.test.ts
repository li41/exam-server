/**
 * Redis integration tests are safe to run in parallel because each file selects
 * a dedicated Redis logical DB via `./redis-test-url.js`.
 *
 * This file uses DB 1. `flushDb()` therefore clears only DB 1 and cannot erase
 * state created by `session-store.integration.test.ts`, which uses DB 2.
 *
 * When adding another integration test file, add a named DB allocation in
 * `redis-test-url.ts`. Duplicate DB indexes fail immediately at module load.
 */
import { createClient } from "redis";
import { describe, expect, it } from "vitest";
import { RedisIdempotencyStore } from "../src/index.js";
import { redisTestUrl } from "./redis-test-url.js";

const connectionString = redisTestUrl("idempotencyStore");
const suite = connectionString ? describe : describe.skip;

suite("RedisIdempotencyStore", () => {
  it("reserves, detects conflicts, completes, and replays responses", async () => {
    const client = createClient({ url: connectionString });
    await client.connect();
    await client.flushDb();
    const store = new RedisIdempotencyStore(client);

    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-1", "hash-a", 60),
    ).resolves.toEqual({ state: "acquired" });
    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-1", "hash-a", 60),
    ).resolves.toEqual({ state: "pending" });
    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-1", "hash-b", 60),
    ).resolves.toEqual({ state: "conflict" });

    await store.complete(
      "tenant-a:POST:/api/items",
      "key-1",
      "hash-a",
      {
        status: 201,
        body: JSON.stringify({ id: "item-1" }),
        contentType: "application/json",
      },
      3600,
    );

    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-1", "hash-a", 60),
    ).resolves.toEqual({
      state: "completed",
      response: {
        status: 201,
        body: JSON.stringify({ id: "item-1" }),
        contentType: "application/json",
      },
    });

    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-2", "hash-a", 60),
    ).resolves.toEqual({ state: "acquired" });
    await store.release("tenant-a:POST:/api/items", "key-2", "hash-a");
    await expect(
      store.reserve("tenant-a:POST:/api/items", "key-2", "hash-a", 60),
    ).resolves.toEqual({ state: "acquired" });

    await client.flushDb();
    await client.quit();
  });
});
