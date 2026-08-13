import { randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";
import type { AuditEventInput, AuditLog } from "@server-foundation/domain";

export class MySqlAuditLog implements AuditLog {
  constructor(private readonly pool: Pool) {}

  async record(event: AuditEventInput): Promise<void> {
    await this.pool.execute(
      `INSERT INTO audit_events (
        id,
        occurred_at,
        tenant_id,
        actor_user_id,
        request_id,
        action,
        resource_type,
        resource_id,
        metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [
        randomUUID(),
        event.occurredAt ? new Date(event.occurredAt) : new Date(),
        event.tenantId,
        event.actorUserId,
        event.requestId,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        JSON.stringify(event.metadata ?? {}),
      ],
    );
  }
}
