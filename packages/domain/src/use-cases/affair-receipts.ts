import type {
  AffairReceiptAccessAction,
  AffairReceiptDetail,
  AffairReceiptListItem,
  AffairReceiptListQuery,
  AffairReceiptLookupInput,
  AffairReceiptSelectionInput,
  CreateAffairReceiptInput,
  Page,
  UpdateAffairReceiptInput,
} from "@server-foundation/api-contracts";
import {
  CapabilityMissingError,
  ConflictError,
  DomainError,
  NotFoundError,
} from "../errors.js";
import type {
  BlobStorage,
  DownloadSource,
  FileAccessScope,
} from "../ports/blob-storage.js";
import type { FileMetadataStore } from "../ports/file-metadata.js";
import type {
  AffairReceiptAccessLog,
  AffairReceiptRepository,
} from "../ports/affair-receipt-repository.js";
import type { AffairRepository } from "../ports/affair-repository.js";
import type { QuestionBankScope } from "../ports/question-bank-repository.js";

export type AffairReceiptAccessActor = {
  actorType: "backend" | "school" | "city";
  actorUserId: string | null;
  actorAccount: string | null;
  ip: string | null;
};

const invalid = (message: string): never => {
  throw new DomainError("validation_error", message);
};

const isValidTwId = (value: string): boolean => {
  const id = value.trim().toUpperCase();
  if (!/^[A-Z][1289]\d{8}$/u.test(id)) return false;
  const letters = "ABCDEFGHJKLMNPQRSTUVXYWZIO";
  const index = letters.indexOf(id[0] ?? "");
  if (index < 0) return false;
  const code = index + 10;
  let sum = Math.floor(code / 10) + (code % 10) * 9;
  const weights = [8, 7, 6, 5, 4, 3, 2, 1, 1];
  for (let i = 1; i < id.length; i++) {
    sum += Number(id[i]) * (weights[i - 1] ?? 0);
  }
  return sum % 10 === 0;
};

const validateBusinessRules = (
  receipt: CreateAffairReceiptInput | AffairReceiptDetail,
): void => {
  if (!isValidTwId(receipt.idNumber)) {
    invalid("idNumber is not a valid Taiwan ID number.");
  }
  if (!receipt.agreed) invalid("The receipt agreement must be accepted.");

  if (receipt.submitterType === "school") {
    if (receipt.positions.length === 0) {
      invalid("At least one school position is required.");
    }
    if (
      !receipt.positions.includes("無擔任") &&
      receipt.positions.includes("監考或資訊教師") &&
      (!receipt.monitorClasses || receipt.monitorClasses < 1)
    ) {
      invalid(
        "monitorClasses is required for monitoring/information teachers.",
      );
    }
  }

  if (receipt.briefingRegion && receipt.briefingRegion !== "online") {
    if (!receipt.transportType) {
      invalid("transportType is required for an in-person briefing.");
    }
    if (receipt.transportType === "rail") {
      if (!receipt.transportOriginArea || !receipt.transportOriginStation) {
        invalid("Rail transport requires an origin area and station.");
      }
      if (
        receipt.transportOriginStation &&
        receipt.transportDestStation &&
        receipt.transportOriginStation === receipt.transportDestStation
      ) {
        invalid("Rail origin and destination stations must differ.");
      }
    }
    if (
      receipt.transportType === "island" &&
      (!receipt.transportFee || receipt.transportFee <= 0)
    ) {
      invalid("Island transport requires a positive transport fee.");
    }
  }
};

export class AffairReceiptService {
  constructor(
    private readonly receipts: AffairReceiptRepository,
    private readonly accessLog: AffairReceiptAccessLog,
    private readonly affairs: AffairRepository,
    private readonly fileMetadata?: FileMetadataStore,
    private readonly blobStorage?: BlobStorage,
  ) {}

  async listReceipts(
    query: AffairReceiptListQuery,
    actor: AffairReceiptAccessActor,
    scope: QuestionBankScope,
  ): Promise<Page<AffairReceiptListItem>> {
    await this.requireAffair(query.affairId, scope);
    const result = await this.receipts.listReceipts(query, scope);
    await this.audit(
      "list",
      query.affairId,
      null,
      result.items.length,
      actor,
      scope,
    );
    return result;
  }

  async getReceipt(
    id: string,
    actor: AffairReceiptAccessActor,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail> {
    const receipt = await this.requireReceipt(id, scope);
    await this.audit("view", receipt.affairId, receipt.id, 1, actor, scope);
    return receipt;
  }

  async lookupByIdNumber(
    input: AffairReceiptLookupInput,
    actor: AffairReceiptAccessActor,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail | null> {
    await this.requireAffair(input.affairId, scope);
    const receipt = await this.receipts.lookupByIdNumber(
      input.affairId,
      input.idNumber.trim().toUpperCase(),
      scope,
    );
    await this.audit(
      "view",
      input.affairId,
      receipt?.id ?? null,
      receipt ? 1 : 0,
      actor,
      scope,
    );
    return receipt;
  }

  async createReceipt(
    input: CreateAffairReceiptInput,
    scope: QuestionBankScope,
    fileScope: FileAccessScope,
  ): Promise<AffairReceiptDetail> {
    await this.requireAffair(input.affairId, scope);
    validateBusinessRules(input);
    await this.assertBankbookReady(input.bankbookFileId, scope, fileScope);
    return this.receipts.createReceipt(input, scope);
  }

  async updateReceipt(
    id: string,
    input: UpdateAffairReceiptInput,
    scope: QuestionBankScope,
    fileScope: FileAccessScope,
  ): Promise<AffairReceiptDetail> {
    const current = await this.requireReceipt(id, scope);
    if (current.version !== input.version) {
      throw new ConflictError(
        "affair receipt was modified by another request.",
      );
    }
    const next = { ...current, ...input } as AffairReceiptDetail;
    validateBusinessRules(next);
    if (input.bankbookFileId) {
      await this.assertBankbookReady(input.bankbookFileId, scope, fileScope);
    }
    const updated = await this.receipts.updateReceipt(id, input, scope);
    if (
      input.bankbookFileId &&
      input.bankbookFileId !== current.bankbookFileId
    ) {
      await this.deleteBlobIfPresent(current.bankbookFileId, scope, fileScope);
    }
    return updated;
  }

  async preparePrint(
    input: AffairReceiptSelectionInput,
    actor: AffairReceiptAccessActor,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail[]> {
    return this.selectWithAudit("print", input, actor, scope);
  }

  async prepareExport(
    input: AffairReceiptSelectionInput,
    actor: AffairReceiptAccessActor,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail[]> {
    return this.selectWithAudit("export", input, actor, scope);
  }

  async getBankbookDownload(
    id: string,
    actor: AffairReceiptAccessActor,
    scope: QuestionBankScope,
    fileScope: FileAccessScope,
  ): Promise<DownloadSource> {
    const receipt = await this.requireReceipt(id, scope);
    await this.audit("view", receipt.affairId, receipt.id, 1, actor, scope);
    return this.requireBlobStorage().getDownload(
      receipt.bankbookFileId,
      fileScope,
    );
  }

  async deleteReceipt(
    id: string,
    version: number,
    actor: AffairReceiptAccessActor,
    scope: QuestionBankScope,
    fileScope: FileAccessScope,
  ): Promise<void> {
    const receipt = await this.requireReceipt(id, scope);
    if (receipt.version !== version) {
      throw new ConflictError(
        "affair receipt was modified by another request.",
      );
    }

    await this.audit("delete", receipt.affairId, receipt.id, 1, actor, scope);

    // PII priority: remove the bankbook blob before the DB row. A subsequent DB
    // failure leaves a visible/repairable missing image, not an untracked PII blob.
    await this.deleteBlobIfPresent(receipt.bankbookFileId, scope, fileScope);
    await this.receipts.deleteReceipt(id, version, scope);
  }

  private async selectWithAudit(
    action: "print" | "export",
    input: AffairReceiptSelectionInput,
    actor: AffairReceiptAccessActor,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail[]> {
    await this.requireAffair(input.affairId, scope);
    const rows = await this.receipts.selectReceipts(input, scope);
    await this.audit(action, input.affairId, null, rows.length, actor, scope);
    return rows;
  }

  private async assertBankbookReady(
    fileId: string,
    scope: QuestionBankScope,
    fileScope: FileAccessScope,
  ): Promise<void> {
    const metadata = await this.requireFileMetadata().get(fileId);
    if (
      !metadata ||
      metadata.tenantId !== scope.tenantId ||
      metadata.status !== "ready"
    ) {
      throw new NotFoundError("bankbook file", fileId);
    }
    if (!metadata.mimeType.startsWith("image/")) {
      invalid("bankbookFileId must reference an image.");
    }
    if (metadata.sizeBytes > 10 * 1024 * 1024) {
      invalid("Bankbook image must not exceed 10 MiB.");
    }

    // BlobStorage owns the existing owner/admin authorization and physical-file
    // existence checks. Opening then cancelling the private stream reuses both.
    const source = await this.requireBlobStorage().getDownload(
      fileId,
      fileScope,
    );
    await source.stream.cancel().catch(() => undefined);
  }

  private async deleteBlobIfPresent(
    fileId: string,
    scope: QuestionBankScope,
    fileScope: FileAccessScope,
  ): Promise<void> {
    const metadata = await this.requireFileMetadata().get(fileId);
    if (!metadata || metadata.status === "deleted") return;
    if (metadata.tenantId !== scope.tenantId) {
      throw new NotFoundError("bankbook file", fileId);
    }
    await this.requireBlobStorage().delete(fileId, fileScope);
  }

  private requireFileMetadata(): FileMetadataStore {
    if (!this.fileMetadata) {
      throw new CapabilityMissingError("file metadata storage");
    }
    return this.fileMetadata;
  }

  private requireBlobStorage(): BlobStorage {
    if (!this.blobStorage) throw new CapabilityMissingError("blob storage");
    return this.blobStorage;
  }

  private async requireAffair(
    id: string,
    scope: QuestionBankScope,
  ): Promise<void> {
    const affair = await this.affairs.getAffair(id, scope);
    if (!affair) throw new NotFoundError("affair", id);
  }

  private async requireReceipt(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail> {
    const receipt = await this.receipts.getReceipt(id, scope);
    if (!receipt) throw new NotFoundError("affair receipt", id);
    return receipt;
  }

  private async audit(
    action: AffairReceiptAccessAction,
    affairId: string,
    receiptId: string | null,
    recordCount: number,
    actor: AffairReceiptAccessActor,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.accessLog.record({
      tenantId: scope.tenantId,
      affairId,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      actorAccount: actor.actorAccount,
      action,
      receiptId,
      recordCount,
      ip: actor.ip,
    });
  }
}
