import * as XLSX from "@e965/xlsx";
import {
  createInMemoryExamineeRepository,
  createInMemoryItemRepository,
  createInMemoryQuestionBankRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mountQuestionBankRoutes } from "../src/question-bank-routes.js";

const localScope = {
  tenantId: "local-development-tenant",
  actorUserId: "local-development-user",
};
const otherScope = {
  tenantId: "other-import-tenant",
  actorUserId: "other-import-user",
};

const headers = ["姓名", "代號", "密碼", "群組", "備註", "狀態"];

const workbookBytes = (
  rows: unknown[][],
  bookType: "xlsx" | "ods" = "xlsx",
): Buffer => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([headers, ...rows]),
    "受測者",
  );
  const output = XLSX.write(workbook, { type: "buffer", bookType });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as Uint8Array);
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

const createImportApp = () => {
  const examinees = createInMemoryExamineeRepository();
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountQuestionBankRoutes(app, {
    repository: createInMemoryQuestionBankRepository(),
    examineeRepository: examinees,
    allowUnauthenticated: true,
  });
  return { app, examinees };
};

describe("examinee import API", () => {
  it("imports a valid xlsx batch, resolves parent/child groups, and preserves PHP status semantics", async () => {
    const { app, examinees } = createImportApp();
    const parent = await examinees.createGroup(
      {
        parentId: null,
        name: "第一梯",
        proctorPassword: null,
        sortOrder: 0,
      },
      localScope,
    );
    const child = await examinees.createGroup(
      {
        parentId: parent.id,
        name: "A班",
        proctorPassword: null,
        sortOrder: 0,
      },
      localScope,
    );
    const response = await app.request("/api/examinee-import", {
      method: "POST",
      body: upload(
        workbookBytes([
          ["王小明", "S001", "pw-001", "第一梯/A班", "備註", "啟用"],
          ["陳小華", "S002", "pw-002", "第一梯", "", "停用"],
        ]),
        "examinees.xlsx",
      ),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      imported: 2,
      updated: 0,
      errors: [],
    });
    await expect(
      examinees.findExamineeByIdentifier("S001", localScope),
    ).resolves.toMatchObject({
      groupId: child.id,
      code: "pw-001",
      status: "enabled",
    });
    await expect(
      examinees.findExamineeByIdentifier("S002", localScope),
    ).resolves.toMatchObject({
      groupId: parent.id,
      status: "disabled",
    });
  });

  it("accepts ods and upserts by identifier instead of inserting a duplicate", async () => {
    const { app, examinees } = createImportApp();
    const first = await app.request("/api/examinee-import", {
      method: "POST",
      body: upload(
        workbookBytes([["原姓名", "UPSERT-1", "old-code", "", "old", "1"]]),
        "first.xlsx",
      ),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/api/examinee-import", {
      method: "POST",
      body: upload(
        workbookBytes(
          [["新姓名", "UPSERT-1", "new-code", "", "new", "0"]],
          "ods",
        ),
        "second.ods",
      ),
    });
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({
      imported: 0,
      updated: 1,
      errors: [],
    });
    await expect(
      examinees.findExamineeByIdentifier("UPSERT-1", localScope),
    ).resolves.toMatchObject({
      name: "新姓名",
      code: "new-code",
      note: "new",
      status: "disabled",
      version: 2,
    });
    const page = await examinees.listExaminees({ limit: 100 }, localScope);
    expect(
      page.items.filter((item) => item.identifier === "UPSERT-1"),
    ).toHaveLength(1);
  });

  it("rejects duplicate identifiers and passwords inside the upload with row coordinates", async () => {
    const { app, examinees } = createImportApp();
    const response = await app.request("/api/examinee-import", {
      method: "POST",
      body: upload(
        workbookBytes([
          ["甲", "DUP-ID", "DUP-CODE", "", "", ""],
          ["乙", "DUP-ID", "OTHER-CODE", "", "", ""],
          ["丙", "OTHER-ID", "DUP-CODE", "", "", ""],
        ]),
        "duplicates.xlsx",
      ),
    });
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result).toMatchObject({ imported: 0, updated: 0 });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sheet: "受測者",
          row: 2,
          identifier: "DUP-ID",
          message: expect.stringContaining("代號"),
        }),
        expect.objectContaining({
          sheet: "受測者",
          row: 4,
          identifier: "OTHER-ID",
          message: expect.stringContaining("密碼"),
        }),
      ]),
    );
    const page = await examinees.listExaminees({ limit: 100 }, localScope);
    expect(page.items).toHaveLength(0);
  });

  it("rolls back the whole batch when a later row conflicts with an existing active password", async () => {
    const { app, examinees } = createImportApp();
    await examinees.createExaminee(
      {
        groupId: null,
        code: "TAKEN-CODE",
        identifier: "EXISTING",
        name: "existing",
        note: null,
        status: "enabled",
      },
      localScope,
    );
    const response = await app.request("/api/examinee-import", {
      method: "POST",
      body: upload(
        workbookBytes([
          ["應回滾", "ROLLBACK-NEW", "free-code", "", "", ""],
          ["衝突", "CONFLICT-NEW", "TAKEN-CODE", "", "", ""],
        ]),
        "rollback.xlsx",
      ),
    });
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result).toMatchObject({ imported: 0, updated: 0 });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 3,
          identifier: "CONFLICT-NEW",
          message: "受測者密碼已存在於此租戶。",
        }),
      ]),
    );
    await expect(
      examinees.findExamineeByIdentifier("ROLLBACK-NEW", localScope),
    ).resolves.toBeNull();
  });

  it("allows the same identifier/password in another tenant and hides foreign group existence", async () => {
    const { app, examinees } = createImportApp();
    await examinees.createExaminee(
      {
        groupId: null,
        code: "CROSS-CODE",
        identifier: "CROSS-ID",
        name: "foreign",
        note: null,
        status: "enabled",
      },
      otherScope,
    );
    const local = await app.request("/api/examinee-import", {
      method: "POST",
      body: upload(
        workbookBytes([["local", "CROSS-ID", "CROSS-CODE", "", "", ""]]),
        "cross.xlsx",
      ),
    });
    expect(local.status).toBe(201);

    await examinees.createGroup(
      {
        parentId: null,
        name: "FOREIGN-ONLY-GROUP",
        proctorPassword: null,
        sortOrder: 0,
      },
      otherScope,
    );
    const errorFor = async (groupName: string, identifier: string) => {
      const response = await app.request("/api/examinee-import", {
        method: "POST",
        body: upload(
          workbookBytes([
            ["x", identifier, `${identifier}-code`, groupName, "", ""],
          ]),
          "group.xlsx",
        ),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      return body.errors[0] as { message: string };
    };
    const foreign = await errorFor("FOREIGN-ONLY-GROUP", "FOREIGN-GROUP-ID");
    const missing = await errorFor("MISSING-GROUP", "MISSING-GROUP-ID");
    expect(foreign.message.replace("FOREIGN-ONLY-GROUP", "MISSING-GROUP")).toBe(
      missing.message,
    );
  });
});
