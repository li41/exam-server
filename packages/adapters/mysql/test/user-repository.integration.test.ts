import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMySqlPool,
  MySqlUserRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const repository = new MySqlUserRepository(pool);

describe("MySqlUserRepository", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute("DELETE FROM users");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates users and normalizes email lookup", async () => {
    const created = await repository.create({
      userId: "user-integration",
      email: "Owner@Example.com",
      tenantId: "tenant-integration",
      roles: ["owner", "member"],
      passwordHash: "argon2-test-hash",
    });

    expect(created).toMatchObject({
      userId: "user-integration",
      email: "owner@example.com",
      tenantId: "tenant-integration",
      roles: ["owner", "member"],
      passwordHash: "argon2-test-hash",
      disabledAt: null,
    });
    await expect(
      repository.findByEmail(" OWNER@example.com "),
    ).resolves.toEqual(created);
  });
});
