import { describe, expect, it } from "vitest";
import { createInMemoryItemRepository } from "@server-foundation/testing";
import { createApp } from "../src/app.js";

const createTestApp = () =>
  createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });

describe("items API", () => {
  it("creates and reads an item through the API contract", async () => {
    const app = createTestApp();
    const createResponse = await app.request("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "客戶名冊" }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created).toMatchObject({
      title: "客戶名冊",
      status: "draft",
      version: 1,
    });

    const getResponse = await app.request(`/api/items/${created.id}`);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual(created);
  });

  it("rejects invalid input before reaching the repository", async () => {
    const app = createTestApp();
    const response = await app.request("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("uses optimistic concurrency for updates", async () => {
    const app = createTestApp();
    const createResponse = await app.request("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "待更新" }),
    });
    const created = await createResponse.json();

    const updateResponse = await app.request(`/api/items/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "已更新", version: created.version }),
    });
    expect(updateResponse.status).toBe(200);

    const staleResponse = await app.request(`/api/items/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "過期更新", version: created.version }),
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      error: { code: "conflict" },
    });
  });

  it("soft-deletes an item and excludes it from later reads", async () => {
    const app = createTestApp();
    const createResponse = await app.request("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "待刪除" }),
    });
    const created = await createResponse.json();

    const deleteResponse = await app.request(
      `/api/items/${created.id}?version=${created.version}`,
      {
        method: "DELETE",
      },
    );
    expect(deleteResponse.status).toBe(204);

    const getResponse = await app.request(`/api/items/${created.id}`);
    expect(getResponse.status).toBe(404);
  });
});
