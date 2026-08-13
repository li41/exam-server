import { describe, expect, it } from "vitest";
import type {
  IdempotencyReservation,
  IdempotencyStore,
  IdempotencyStoredResponse,
} from "@server-foundation/domain";
import { createInMemoryItemRepository } from "@server-foundation/testing";
import { createApp } from "../src/app.js";

type MemoryEntry = {
  requestHash: string;
  state: "pending" | "completed";
  response?: IdempotencyStoredResponse;
};

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, MemoryEntry>();

  private entryKey(scope: string, key: string): string {
    return `${scope}\0${key}`;
  }

  async reserve(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyReservation> {
    const existing = this.entries.get(this.entryKey(scope, key));
    if (!existing) {
      this.entries.set(this.entryKey(scope, key), {
        requestHash,
        state: "pending",
      });
      return { state: "acquired" };
    }
    if (existing.requestHash !== requestHash) return { state: "conflict" };
    if (existing.state === "pending") return { state: "pending" };
    return { state: "completed", response: existing.response! };
  }

  async complete(
    scope: string,
    key: string,
    requestHash: string,
    response: IdempotencyStoredResponse,
  ): Promise<void> {
    this.entries.set(this.entryKey(scope, key), {
      requestHash,
      state: "completed",
      response,
    });
  }

  async release(scope: string, key: string): Promise<void> {
    this.entries.delete(this.entryKey(scope, key));
  }
}

const jsonHeaders = (idempotencyKey?: string) => ({
  "content-type": "application/json",
  ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
});

describe("API versioning and idempotency", () => {
  it("serves v1 and keeps /api as a legacy alias", async () => {
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      allowUnauthenticatedItems: true,
    });

    const versioned = await app.request("/api/v1/items");
    const legacy = await app.request("/api/items");

    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("x-api-version")).toBe("v1");
    expect(versioned.headers.get("x-api-legacy-route")).toBeNull();
    expect(legacy.status).toBe(200);
    expect(legacy.headers.get("x-api-version")).toBe("v1");
    expect(legacy.headers.get("x-api-legacy-route")).toBe("true");
  });

  it("replays a successful mutation for the same Idempotency-Key", async () => {
    const store = new MemoryIdempotencyStore();
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      idempotencyStore: store,
      allowUnauthenticatedItems: true,
    });

    const first = await app.request("/api/v1/items", {
      method: "POST",
      headers: jsonHeaders("create-item-1"),
      body: JSON.stringify({ title: "Only once" }),
    });
    const firstBody = await first.json();
    const second = await app.request("/api/v1/items", {
      method: "POST",
      headers: jsonHeaders("create-item-1"),
      body: JSON.stringify({ title: "Only once" }),
    });
    const secondBody = await second.json();
    const list = await (await app.request("/api/v1/items")).json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("x-idempotent-replay")).toBe("true");
    expect(secondBody).toEqual(firstBody);
    expect(list.items).toHaveLength(1);
  });

  it("rejects reusing an Idempotency-Key for a different request", async () => {
    const store = new MemoryIdempotencyStore();
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      idempotencyStore: store,
      allowUnauthenticatedItems: true,
    });

    await app.request("/api/v1/items", {
      method: "POST",
      headers: jsonHeaders("create-item-conflict"),
      body: JSON.stringify({ title: "First" }),
    });
    const conflicting = await app.request("/api/v1/items", {
      method: "POST",
      headers: jsonHeaders("create-item-conflict"),
      body: JSON.stringify({ title: "Different" }),
    });

    expect(conflicting.status).toBe(409);
    await expect(conflicting.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("does not silently ignore Idempotency-Key without durable storage", async () => {
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      allowUnauthenticatedItems: true,
    });
    const response = await app.request("/api/v1/items", {
      method: "POST",
      headers: jsonHeaders("missing-store"),
      body: JSON.stringify({ title: "Needs Redis" }),
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "capability_missing" },
    });
  });
});
