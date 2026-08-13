import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMySqlPool,
  MySqlIdempotencyStore,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const store = new MySqlIdempotencyStore(pool);

describe("MySqlIdempotencyStore", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute("DELETE FROM idempotency_records");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists successful responses for replay and rejects hash conflicts", async () => {
    const scope = "tenant-a:POST:/api/items";
    await expect(store.reserve(scope, "key-1", "hash-a", 60)).resolves.toEqual({
      state: "acquired",
    });
    await expect(store.reserve(scope, "key-1", "hash-a", 60)).resolves.toEqual({
      state: "pending",
    });
    await expect(store.reserve(scope, "key-1", "hash-b", 60)).resolves.toEqual({
      state: "conflict",
    });

    await store.complete(
      scope,
      "key-1",
      "hash-a",
      {
        status: 201,
        body: JSON.stringify({ id: "item-1" }),
        contentType: "application/json",
      },
      3600,
    );

    await expect(store.reserve(scope, "key-1", "hash-a", 60)).resolves.toEqual({
      state: "completed",
      response: {
        status: 201,
        body: JSON.stringify({ id: "item-1" }),
        contentType: "application/json",
      },
    });
  });

  it("fails closed instead of reopening an ambiguous pending mutation", async () => {
    const scope = "tenant-a:DELETE:/api/files/file-1";
    await expect(
      store.reserve(scope, "ambiguous-key", "hash-a", 1),
    ).resolves.toEqual({ state: "acquired" });

    // release() is deliberately conservative for the production MySQL store.
    // An error or process interruption cannot prove that no side effect happened.
    await store.release(scope, "ambiguous-key", "hash-a");

    await expect(
      store.reserve(scope, "ambiguous-key", "hash-a", 1),
    ).resolves.toEqual({ state: "pending" });
  });
});
