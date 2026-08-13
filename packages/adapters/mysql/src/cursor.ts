export type ItemCursor = {
  updatedAt: string;
  id: string;
};

export const encodeItemCursor = (cursor: ItemCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

export const decodeItemCursor = (value: string): ItemCursor | null => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "updatedAt" in parsed &&
      "id" in parsed &&
      typeof parsed.updatedAt === "string" &&
      typeof parsed.id === "string" &&
      parsed.updatedAt.length > 0 &&
      parsed.id.length > 0
    ) {
      return { updatedAt: parsed.updatedAt, id: parsed.id };
    }
  } catch {
    // Invalid cursors are reported by the repository as a domain error.
  }
  return null;
};
