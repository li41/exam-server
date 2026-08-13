import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@server-foundation/domain";
import {
  createMySqlPool,
  MySqlItemRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const repository = new MySqlItemRepository(pool);
const scope = { tenantId: "tenant-integration" };

describe("MySqlItemRepository", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute("DELETE FROM items");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies migrations idempotently and paginates with an opaque cursor", async () => {
    await runMigrations(pool);
    await repository.create({ title: "第一筆" }, scope);
    await repository.create({ title: "第二筆" }, scope);
    await repository.create({ title: "第三筆" }, scope);

    const firstPage = await repository.list({ limit: 2 }, scope);
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));

    const secondPage = await repository.list(
      {
        limit: 2,
        cursor: firstPage.page.nextCursor ?? undefined,
      },
      scope,
    );
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([...firstPage.items, ...secondPage.items]).size).toBe(3);
  });

  it("escapes search wildcards and rejects stale updates", async () => {
    const item = await repository.create({ title: "100% coverage" }, scope);
    const search = await repository.list({ limit: 20, search: "100%" }, scope);
    expect(search.items.map(({ id }) => id)).toContain(item.id);

    const updated = await repository.update(
      item.id,
      {
        title: "已更新",
        version: item.version,
      },
      scope,
    );
    expect(updated.version).toBe(item.version + 1);
    await expect(
      repository.update(
        item.id,
        { title: "過期更新", version: item.version },
        scope,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("soft-deletes an item and rejects later access", async () => {
    const item = await repository.create({ title: "待刪除" }, scope);
    await repository.softDelete(item.id, item.version, scope);

    expect(await repository.get(item.id, scope)).toBeNull();
    await expect(
      repository.softDelete(item.id, item.version, scope),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
