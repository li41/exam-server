import type {
  FileMetadata,
  UploadProgress,
  UploadSession,
} from "@server-foundation/api-contracts";
import { AffairService } from "@server-foundation/domain";
import type {
  BlobStorage,
  FileAccessScope,
  FileMetadataStore,
  UploadInput,
} from "@server-foundation/domain";
import {
  createInMemoryAffairReceiptRepository,
  createInMemoryAffairRepository,
  createInMemoryItemRepository,
  InMemoryAffairReceiptAccessLog,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { mountAffairReceiptRoutes } from "../src/affair-receipt-routes.js";
import { createApp } from "../src/app.js";

class MemoryFileMetadata implements FileMetadataStore {
  readonly items = new Map<string, FileMetadata>();
  async createPending(metadata: FileMetadata): Promise<void> {
    this.items.set(metadata.fileId, structuredClone(metadata));
  }
  async get(fileId: string): Promise<FileMetadata | null> {
    return structuredClone(this.items.get(fileId) ?? null);
  }
  async markReady(fileId: string): Promise<void> {
    const item = this.items.get(fileId);
    if (item) item.status = "ready";
  }
  async markDeleted(fileId: string): Promise<void> {
    const item = this.items.get(fileId);
    if (item) {
      item.status = "deleted";
      item.deletedAt = new Date().toISOString();
    }
  }
}

class MemoryBlobStorage implements BlobStorage {
  readonly deleted: string[] = [];
  async initiateUpload(_input: UploadInput): Promise<UploadSession> {
    throw new Error("not used");
  }
  async writeUpload(
    _sessionId: string,
    _body: ReadableStream<Uint8Array>,
    _scope: FileAccessScope,
  ): Promise<UploadProgress> {
    throw new Error("not used");
  }
  async completeUpload(
    _sessionId: string,
    _scope: FileAccessScope,
  ): Promise<FileMetadata> {
    throw new Error("not used");
  }
  async cancelUpload(
    _sessionId: string,
    _scope: FileAccessScope,
  ): Promise<void> {}
  async getDownload(_fileId: string, _scope: FileAccessScope) {
    return {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      contentLength: 3,
      mimeType: "image/webp",
      fileName: "bankbook.webp",
    };
  }
  async delete(fileId: string, _scope: FileAccessScope): Promise<void> {
    this.deleted.push(fileId);
  }
}

const tenant = {
  tenantId: "local-development-tenant",
  actorUserId: "local-development-user",
};

const affairInput = {
  name: "D wave affair",
  description: null,
  status: "enabled" as const,
  cityLoginStart: null,
  cityLoginEnd: null,
  schoolLoginStart: null,
  schoolLoginEnd: null,
  feeCityContact: 0,
  feeSchoolContact: 0,
  feeTeacherSetup: 0,
  feeTeacherMonitor1: 0,
  feeTeacherMonitor2: 0,
  feeTeacherMonitor3: 0,
  transportReceiptSchool: false,
  transportReceiptCity: false,
  briefingRegions: null,
  receiptYear: null,
  receiptNote: null,
  receiptPrintSchool: false,
  receiptPrintCity: false,
};

const receiptPayload = (affairId: string, schoolId: string, fileId: string) => ({
  affairId,
  submitterType: "school" as const,
  schoolId,
  accountType: "SC" as const,
  account: "SC001",
  name: "王小明",
  jobTitle: "主任",
  idNumber: "A123456789",
  residentCert: null,
  taxId: null,
  phoneArea: "02",
  phoneNumber: "12345678",
  phoneExt: null,
  mobile: "0912345678",
  email: "receipt@example.test",
  addrCity: "臺北市",
  addrDistrict: "中正區",
  addrDetail: "測試路 1 號",
  bankId: "004",
  bankSubid: "0001",
  bankAccount: "1234567890",
  bankbookFileId: fileId,
  positions: ["學校聯絡人" as const],
  monitorClasses: null,
  briefingRegion: null,
  transportType: null,
  transportOriginArea: null,
  transportOriginStation: null,
  transportDestStation: null,
  transportFee: null,
  agreed: true,
});

const setup = async () => {
  const affairs = createInMemoryAffairRepository();
  const affairService = new AffairService(affairs);
  const affair = await affairService.createAffair(affairInput, tenant);
  const school = await affairService.createSchool(
    {
      affairId: affair.id,
      city: "臺北市",
      schoolLevel: 2,
      schoolCode: "001",
      schoolName: "測試國中",
      testClasses: 1,
      testSessions: 1,
      receiptCode: null,
      briefingOptions: null,
      password: "001",
      status: "enabled",
    },
    tenant,
  );
  const receipts = createInMemoryAffairReceiptRepository(affairs);
  const accessLog = new InMemoryAffairReceiptAccessLog();
  const files = new MemoryFileMetadata();
  const blobs = new MemoryBlobStorage();
  const fileId = "bankbook-file-1";
  files.items.set(fileId, {
    fileId,
    ownerId: tenant.actorUserId,
    tenantId: tenant.tenantId,
    originalName: "bankbook.webp",
    displayName: "bankbook.webp",
    mimeType: "image/webp",
    sizeBytes: 3,
    checksum: "a".repeat(64),
    status: "ready",
    createdAt: new Date().toISOString(),
    deletedAt: null,
  });
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountAffairReceiptRoutes(app, {
    repository: receipts,
    accessLog,
    affairRepository: affairs,
    fileMetadata: files,
    blobStorage: blobs,
    allowUnauthenticated: true,
    trustProxyHeaders: true,
  });
  return { app, affair, school, accessLog, files, blobs, fileId };
};

const requestJson = (
  app: Awaited<ReturnType<typeof setup>>["app"],
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.20",
    },
    body: JSON.stringify(body),
  });

describe("affair D-wave receipt API", () => {
  it("keeps sensitive fields out of list responses and audits list before returning", async () => {
    const state = await setup();
    const created = await requestJson(
      state.app,
      "POST",
      "/api/v1/affair-receipts",
      receiptPayload(state.affair.id, state.school.id, state.fileId),
    );
    expect(created.status).toBe(201);

    const list = await state.app.request(
      `/api/v1/affair-receipts?affairId=${state.affair.id}`,
      { headers: { "x-forwarded-for": "203.0.113.20" } },
    );
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).not.toHaveProperty("idNumber");
    expect(body.items[0]).not.toHaveProperty("bankAccount");
    expect(body.items[0]).not.toHaveProperty("bankbookFileId");
    expect(state.accessLog.events.at(-1)).toMatchObject({
      action: "list",
      recordCount: 1,
      ip: "203.0.113.20",
    });
  });

  it("writes print/export audit and fails closed when the audit cannot be persisted", async () => {
    const state = await setup();
    const created = await requestJson(
      state.app,
      "POST",
      "/api/v1/affair-receipts",
      receiptPayload(state.affair.id, state.school.id, state.fileId),
    );
    const receipt = await created.json();

    const printed = await requestJson(
      state.app,
      "POST",
      "/api/v1/affair-receipts/print",
      { affairId: state.affair.id, ids: [receipt.id] },
    );
    expect(printed.status).toBe(200);
    expect(state.accessLog.events.at(-1)).toMatchObject({
      action: "print",
      recordCount: 1,
    });

    const exported = await requestJson(
      state.app,
      "POST",
      "/api/v1/affair-receipts/export",
      { affairId: state.affair.id, ids: [receipt.id] },
    );
    expect(exported.status).toBe(200);
    expect(state.accessLog.events.at(-1)).toMatchObject({
      action: "export",
      recordCount: 1,
    });

    state.accessLog.failActions.add("export");
    const denied = await requestJson(
      state.app,
      "POST",
      "/api/v1/affair-receipts/export",
      { affairId: state.affair.id, ids: [receipt.id] },
    );
    expect(denied.status).toBe(500);
    const deniedBody = await denied.text();
    expect(deniedBody).not.toContain("A123456789");
    expect(deniedBody).not.toContain("1234567890");
  });

  it("does not delete business data when the delete audit fails", async () => {
    const state = await setup();
    const created = await requestJson(
      state.app,
      "POST",
      "/api/v1/affair-receipts",
      receiptPayload(state.affair.id, state.school.id, state.fileId),
    );
    const receipt = await created.json();
    state.accessLog.failActions.add("delete");

    const denied = await state.app.request(
      `/api/v1/affair-receipts/${receipt.id}?version=${receipt.version}`,
      {
        method: "DELETE",
        headers: { "x-forwarded-for": "203.0.113.20" },
      },
    );
    expect(denied.status).toBe(500);
    expect(state.blobs.deleted).toEqual([]);

    const detail = await state.app.request(
      `/api/v1/affair-receipts/${receipt.id}`,
    );
    expect(detail.status).toBe(200);
  });
});
