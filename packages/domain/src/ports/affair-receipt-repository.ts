import type {
  AffairReceiptAccessAction,
  AffairReceiptActorType,
  AffairReceiptDetail,
  AffairReceiptListItem,
  AffairReceiptListQuery,
  AffairReceiptSelectionInput,
  CreateAffairReceiptInput,
  Page,
  UpdateAffairReceiptInput,
} from "@server-foundation/api-contracts";
import type { QuestionBankScope } from "./question-bank-repository.js";

export interface AffairReceiptRepository {
  listReceipts(
    query: AffairReceiptListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<AffairReceiptListItem>>;
  getReceipt(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail | null>;
  createReceipt(
    input: CreateAffairReceiptInput,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail>;
  updateReceipt(
    id: string,
    input: UpdateAffairReceiptInput,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail>;
  lookupByIdNumber(
    affairId: string,
    idNumber: string,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail | null>;
  selectReceipts(
    input: AffairReceiptSelectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail[]>;
  deleteReceipt(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;
}

export type AffairReceiptAccessEvent = {
  tenantId: string;
  affairId: string;
  actorType: AffairReceiptActorType;
  actorUserId: string | null;
  actorAccount: string | null;
  action: AffairReceiptAccessAction;
  receiptId: string | null;
  recordCount: number;
  ip: string | null;
  createdAt?: string;
};

export interface AffairReceiptAccessLog {
  record(event: AffairReceiptAccessEvent): Promise<void>;
}
