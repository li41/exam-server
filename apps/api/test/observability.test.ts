import { describe, expect, it } from "vitest";
import type { AuditEventInput, AuditLog } from "@server-foundation/domain";
import { createInMemoryItemRepository } from "@server-foundation/testing";
import { createApp } from "../src/app.js";
import type { LogFields, Logger } from "../src/logger.js";

type LogRecord = {
  level: "info" | "warn" | "error";
  event: string;
  fields: LogFields;
};

const createMemoryLogger = () => {
  const records: LogRecord[] = [];
  const logger: Logger = {
    info: (event, fields = {}) =>
      records.push({ level: "info", event, fields }),
    warn: (event, fields = {}) =>
      records.push({ level: "warn", event, fields }),
    error: (event, fields = {}) =>
      records.push({ level: "error", event, fields }),
  };
  return { logger, records };
};

class MemoryAuditLog implements AuditLog {
  readonly events: AuditEventInput[] = [];

  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

describe("API observability", () => {
  it("preserves a valid request ID in the response and request log", async () => {
    const { logger, records } = createMemoryLogger();
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      logger,
    });
    const requestId = "123e4567-e89b-42d3-a456-426614174000";

    const response = await app.request("/health/live", {
      headers: { "x-request-id": requestId },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "info",
        event: "http_request",
        fields: expect.objectContaining({
          requestId,
          method: "GET",
          path: "/health/live",
          status: 200,
        }),
      }),
    );
  });

  it("replaces an invalid client-supplied request ID", async () => {
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
    });
    const response = await app.request("/health/live", {
      headers: { "x-request-id": "client-controlled-value" },
    });
    const requestId = response.headers.get("x-request-id");

    expect(requestId).not.toBe("client-controlled-value");
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("reports readiness failures without exposing backend error details", async () => {
    const { logger, records } = createMemoryLogger();
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      logger,
      readinessChecks: {
        mysql: async () => undefined,
        redis: async () => {
          throw new Error("redis://user:secret@internal.example failed");
        },
      },
    });

    const response = await app.request("/health/ready");
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      status: "unavailable",
      checks: {
        mysql: { status: "ok" },
        redis: { status: "error" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "readiness_check_failed",
        fields: expect.objectContaining({ check: "redis" }),
      }),
    );
  });

  it("records authenticated mutation metadata without request bodies", async () => {
    const auditLog = new MemoryAuditLog();
    const requestId = "123e4567-e89b-42d3-a456-426614174001";
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      auditLog,
      allowUnauthenticatedItems: true,
    });

    const response = await app.request("/api/items", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify({ title: "Audited item" }),
    });

    expect(response.status).toBe(201);
    expect(auditLog.events).toEqual([
      expect.objectContaining({
        requestId,
        tenantId: "local-development-tenant",
        actorUserId: "local-development-user",
        action: "http.post",
        resourceType: "item",
        metadata: {
          method: "POST",
          path: "/api/items",
          status: 201,
        },
      }),
    ]);
    expect(JSON.stringify(auditLog.events)).not.toContain("Audited item");
  });

  it("keeps a successful response when audit persistence fails", async () => {
    const { logger, records } = createMemoryLogger();
    const auditLog: AuditLog = {
      async record() {
        throw new Error("audit database unavailable");
      },
    };
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      auditLog,
      logger,
      allowUnauthenticatedItems: true,
    });

    const response = await app.request("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Still succeeds" }),
    });

    expect(response.status).toBe(201);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "audit_record_failed",
      }),
    );
  });

  it("keeps the legacy health endpoint as a liveness alias", async () => {
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
    });
    await expect((await app.request("/health")).json()).resolves.toEqual({
      status: "ok",
    });
  });
});
