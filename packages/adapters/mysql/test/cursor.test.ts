import { describe, expect, it } from "vitest";
import { decodeItemCursor, encodeItemCursor } from "../src/cursor.js";

describe("MySQL item cursor", () => {
  it("round-trips the stable sort key", () => {
    const cursor = { updatedAt: "2026-08-09T05:00:00.123Z", id: "item-1" };
    expect(decodeItemCursor(encodeItemCursor(cursor))).toEqual(cursor);
  });

  it("returns null for malformed values", () => {
    expect(decodeItemCursor("not-a-cursor")).toBeNull();
  });
});
