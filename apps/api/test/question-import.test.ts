import * as XLSX from "@e965/xlsx";
import { QuestionTypeSchema } from "@server-foundation/api-contracts";
import type {
  IdempotencyReservation,
  IdempotencyStore,
  IdempotencyStoredResponse,
} from "@server-foundation/domain";
import {
  createInMemoryItemRepository,
  createInMemoryQuestionBankRepository,
  createInMemoryQuestionImportRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mountQuestionBankRoutes } from "../src/question-bank-routes.js";

const importHeaders = [
  "code",
  "stem",
  "category",
  "difficulty",
  "points",
  "tags",
  "status",
  "explanation",
  "options_json",
  "answer_json",
  "ai_rubric_json",
];

const workbookBytes = (
  type: string,
  rows: unknown[][],
  bookType: "xlsx" | "ods" = "xlsx",
): Buffer => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([importHeaders, ...rows]),
    type,
  );
  const output = XLSX.write(workbook, { type: "buffer", bookType });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as Uint8Array);
};

const trueFalseRow = (
  code: string,
  answer: { value: unknown } = { value: true },
) => [
  code,
  "水的化學式是 H2O。",
  "",
  "3",
  "1",
  "化學,基礎",
  "enabled",
  "",
  "",
  JSON.stringify(answer),
  "",
];

const createImportApp = (idempotencyStore?: IdempotencyStore) => {
  const questions = createInMemoryQuestionBankRepository();
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountQuestionBankRoutes(app, {
    repository: questions,
    importRepository: createInMemoryQuestionImportRepository(questions),
    allowUnauthenticated: true,
    idempotencyStore,
  });
  return { app, questions };
};

const upload = (bytes: Buffer, filename: string): FormData => {
  const form = new FormData();
  form.set(
    "file",
    new File([Uint8Array.from(bytes)], filename, {
      type: "application/octet-stream",
    }),
  );
  return form;
};

type Stored = {
  hash: string;
  response?: IdempotencyStoredResponse;
};

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Stored>();

  async reserve(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyReservation> {
    const storageKey = `${scope}:${key}`;
    const current = this.entries.get(storageKey);
    if (!current) {
      this.entries.set(storageKey, { hash: requestHash });
      return { state: "acquired" };
    }
    if (current.hash !== requestHash) return { state: "conflict" };
    if (current.response) {
      return { state: "completed", response: current.response };
    }
    return { state: "pending" };
  }

  async complete(
    scope: string,
    key: string,
    requestHash: string,
    response: IdempotencyStoredResponse,
  ): Promise<void> {
    this.entries.set(`${scope}:${key}`, { hash: requestHash, response });
  }

  async release(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<void> {
    const storageKey = `${scope}:${key}`;
    if (this.entries.get(storageKey)?.hash === requestHash) {
      this.entries.delete(storageKey);
    }
  }
}

describe("question import API", () => {
  it("downloads an xlsx template with one sheet for every server question type and no media column", async () => {
    const { app } = createImportApp();
    const response = await app.request("/api/question-import/template");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), {
      type: "buffer",
    });
    expect(workbook.SheetNames).toEqual(QuestionTypeSchema.options);
    for (const name of workbook.SheetNames) {
      const sheet = workbook.Sheets[name];
      expect(sheet).toBeDefined();
      const firstRow = XLSX.utils.sheet_to_json<unknown[]>(sheet!, {
        header: 1,
        raw: false,
        defval: "",
      })[0] as unknown[];
      expect(firstRow).toContain("answer_json");
      expect(firstRow).not.toContain("media");
      expect(firstRow).not.toContain("fileId");
    }
  });

  it("imports a valid xlsx batch and resolves an exact parent/child category path", async () => {
    const { app } = createImportApp();
    const parent = await (
      await app.request("/api/question-categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "數學", parentId: null }),
      })
    ).json();
    const child = await (
      await app.request("/api/question-categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "代數", parentId: parent.id }),
      })
    ).json();
    const bytes = workbookBytes("single_choice", [
      [
        "IMPORT-XLSX-1",
        "1 + 1 = ?",
        "數學/代數",
        "易",
        "2",
        "數學,基礎",
        "啟用",
        "",
        JSON.stringify([
          { id: "A", text: "2" },
          { id: "B", text: "3" },
        ]),
        JSON.stringify({ value: "A" }),
        "",
      ],
    ]);

    const response = await app.request("/api/question-import", {
      method: "POST",
      body: upload(bytes, "questions.xlsx"),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ imported: 1, errors: [] });

    const page = await (await app.request("/api/questions?limit=20")).json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      code: "IMPORT-XLSX-1",
      categoryId: child.id,
      media: [],
      difficulty: 2,
      points: 2,
    });
  });

  it("accepts ods and uses the same server-side validation", async () => {
    const { app } = createImportApp();
    const bytes = workbookBytes(
      "true_false",
      [trueFalseRow("IMPORT-ODS-1")],
      "ods",
    );
    const response = await app.request("/api/question-import", {
      method: "POST",
      body: upload(bytes, "questions.ods"),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ imported: 1, errors: [] });
  });

  it("reports the exact bad sheet/row and imports nothing when any row is invalid", async () => {
    const { app } = createImportApp();
    const bytes = workbookBytes("true_false", [
      trueFalseRow("GOOD-ROW"),
      trueFalseRow("BAD-ROW", { value: "maybe" }),
    ]);
    const response = await app.request("/api/question-import", {
      method: "POST",
      body: upload(bytes, "mixed.xlsx"),
    });
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.imported).toBe(0);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sheet: "true_false",
          row: 3,
          code: "BAD-ROW",
          message: expect.stringContaining("true_false answer.value"),
        }),
      ]),
    );
    const page = await (await app.request("/api/questions?limit=20")).json();
    expect(page.items).toHaveLength(0);
  });

  it("replays a successful multipart import with the same idempotency key without double-writing", async () => {
    const store = new MemoryIdempotencyStore();
    const { app } = createImportApp(store);
    const bytes = workbookBytes("true_false", [trueFalseRow("IDEMPOTENT-1")]);

    const first = await app.request("/api/question-import", {
      method: "POST",
      headers: { "idempotency-key": "import-1" },
      body: upload(bytes, "questions.xlsx"),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/api/question-import", {
      method: "POST",
      headers: { "idempotency-key": "import-1" },
      body: upload(bytes, "questions.xlsx"),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get("x-idempotent-replay")).toBe("true");

    const page = await (await app.request("/api/questions?limit=20")).json();
    expect(page.items.map((item: { code: string }) => item.code)).toEqual([
      "IDEMPOTENT-1",
    ]);
  });
});
