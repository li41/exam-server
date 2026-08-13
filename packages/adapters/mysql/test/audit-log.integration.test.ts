import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RowDataPacket } from "mysql2/promise";
import { createMySqlPool, MySqlAuditLog, runMigrations } from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const auditLog = new MySqlAuditLog(pool);

describe("MySqlAuditLog", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute("DELETE FROM audit_events");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists tenant-scoped mutation metadata without request bodies", async () => {
    await auditLog.record({
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      tenantId: "tenant-audit",
      actorUserId: "user-audit",
      action: "update.item",
      resourceType: "item",
      resourceId: "item-1",
      occurredAt: "2026-08-10T12:00:00.000Z",
      metadata: { method: "PATCH", path: "/api/items/item-1", status: 200 },
    });

    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT tenant_id, actor_user_id, request_id, action, resource_type, resource_id, metadata FROM audit_events WHERE request_id = ?",
      ["123e4567-e89b-42d3-a456-426614174000"],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: "tenant-audit",
      actor_user_id: "user-audit",
      action: "update.item",
      resource_type: "item",
      resource_id: "item-1",
    });
    expect(rows[0]?.metadata).toMatchObject({
      method: "PATCH",
      path: "/api/items/item-1",
      status: 200,
    });
  });
});
