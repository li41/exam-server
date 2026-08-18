import type {
  AffairReceiptDetail,
  AffairReceiptListItem,
  AffairReceiptListQuery,
  AffairReceiptSelectionInput,
  CreateAffairReceiptInput,
  Page,
  UpdateAffairReceiptInput,
} from "@server-foundation/api-contracts";
import { ConflictError, NotFoundError } from "@server-foundation/domain";
import type {
  AffairReceiptAccessEvent,
  AffairReceiptAccessLog,
  AffairReceiptRepository,
  AffairRepository,
  QuestionBankScope,
} from "@server-foundation/domain";

const randomUUID = (): string => globalThis.crypto.randomUUID();
const copy = <T>(value: T): T => structuredClone(value);
const now = (): string => new Date().toISOString();

const toListItem = (item: AffairReceiptDetail): AffairReceiptListItem => ({
  id: item.id,
  tenantId: item.tenantId,
  affairId: item.affairId,
  submitterType: item.submitterType,
  schoolId: item.schoolId,
  cityId: item.cityId,
  accountType: item.accountType,
  account: item.account,
  name: item.name,
  positions: copy(item.positions),
  monitorClasses: item.monitorClasses,
  briefingRegion: item.briefingRegion,
  transportType: item.transportType,
  transportFee: item.transportFee,
  agreed: item.agreed,
  version: item.version,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

class InMemoryAffairReceiptRepository implements AffairReceiptRepository {
  private readonly items: AffairReceiptDetail[] = [];

  constructor(private readonly affairs: AffairRepository) {}

  async listReceipts(
    query: AffairReceiptListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<AffairReceiptListItem>> {
    const keyword = query.keyword?.toUpperCase();
    const items = this.items
      .filter(
        (item) =>
          item.tenantId === scope.tenantId &&
          item.affairId === query.affairId &&
          (!query.submitterType || item.submitterType === query.submitterType) &&
          (!query.keyword ||
            item.name.includes(query.keyword) ||
            item.account.includes(query.keyword) ||
            item.idNumber.toUpperCase() === keyword),
      )
      .sort((a, b) =>
        b.updatedAt === a.updatedAt
          ? b.id.localeCompare(a.id)
          : b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, query.limit)
      .map((item) => toListItem(item));
    return { items, page: { nextCursor: null } };
  }

  async getReceipt(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail | null> {
    const item = this.items.find(
      (candidate) => candidate.id === id && candidate.tenantId === scope.tenantId,
    );
    return item ? copy(item) : null;
  }

  async createReceipt(
    input: CreateAffairReceiptInput,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail> {
    await this.assertParents(input, scope);
    if (
      this.items.some(
        (item) =>
          item.tenantId === scope.tenantId &&
          item.affairId === input.affairId &&
          item.account === input.account,
      )
    ) {
      throw new ConflictError("A receipt already exists for this affair account.");
    }
    const timestamp = now();
    const item: AffairReceiptDetail = {
      id: randomUUID(),
      tenantId: scope.tenantId,
      affairId: input.affairId,
      submitterType: input.submitterType,
      schoolId: input.submitterType === "school" ? input.schoolId : null,
      cityId: input.submitterType === "city" ? input.cityId : null,
      accountType: input.accountType,
      account: input.account,
      name: input.name,
      jobTitle: input.jobTitle,
      idNumber: input.idNumber.trim().toUpperCase(),
      residentCert: input.residentCert,
      taxId: input.taxId,
      phoneArea: input.phoneArea,
      phoneNumber: input.phoneNumber,
      phoneExt: input.phoneExt,
      mobile: input.mobile,
      email: input.email,
      addrCity: input.addrCity,
      addrDistrict: input.addrDistrict,
      addrDetail: input.addrDetail,
      bankId: input.bankId,
      bankSubid: input.bankSubid,
      bankAccount: input.bankAccount,
      bankbookFileId: input.bankbookFileId,
      positions: copy(input.positions),
      monitorClasses: input.monitorClasses,
      briefingRegion: input.briefingRegion,
      transportType: input.transportType,
      transportOriginArea: input.transportOriginArea,
      transportOriginStation: input.transportOriginStation,
      transportDestStation: input.transportDestStation,
      transportFee: input.transportFee,
      agreed: input.agreed,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.items.push(item);
    return copy(item);
  }

  async updateReceipt(
    id: string,
    input: UpdateAffairReceiptInput,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail> {
    const item = this.require(id, scope);
    if (item.version !== input.version) {
      throw new ConflictError("affair receipt was modified by another request.");
    }
    const { version: _version, ...patch } = input;
    Object.assign(item, copy(patch));
    item.version++;
    item.updatedAt = now();
    return copy(item);
  }

  async lookupByIdNumber(
    affairId: string,
    idNumber: string,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail | null> {
    const normalized = idNumber.trim().toUpperCase();
    const item = this.items.find(
      (candidate) =>
        candidate.tenantId === scope.tenantId &&
        candidate.affairId === affairId &&
        candidate.idNumber.toUpperCase() === normalized,
    );
    return item ? copy(item) : null;
  }

  async selectReceipts(
    input: AffairReceiptSelectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail[]> {
    const selected = new Set(input.ids);
    return this.items
      .filter(
        (item) =>
          item.tenantId === scope.tenantId &&
          item.affairId === input.affairId &&
          (selected.size === 0 || selected.has(item.id)),
      )
      .map((item) => copy(item));
  }

  async deleteReceipt(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const index = this.items.findIndex(
      (item) => item.id === id && item.tenantId === scope.tenantId,
    );
    if (index < 0) throw new NotFoundError("affair receipt", id);
    const item = this.items[index] as AffairReceiptDetail;
    if (item.version !== version) {
      throw new ConflictError("affair receipt was modified by another request.");
    }
    this.items.splice(index, 1);
  }

  private require(id: string, scope: QuestionBankScope): AffairReceiptDetail {
    const item = this.items.find(
      (candidate) => candidate.id === id && candidate.tenantId === scope.tenantId,
    );
    if (!item) throw new NotFoundError("affair receipt", id);
    return item;
  }

  private async assertParents(
    input: CreateAffairReceiptInput,
    scope: QuestionBankScope,
  ): Promise<void> {
    const affair = await this.affairs.getAffair(input.affairId, scope);
    if (!affair) throw new NotFoundError("affair", input.affairId);
    if (input.submitterType === "school") {
      const school = await this.affairs.getSchool(input.schoolId, scope);
      if (!school || school.affairId !== input.affairId) {
        throw new NotFoundError("affair school", input.schoolId);
      }
    } else {
      const city = (await this.affairs.listCities(scope)).find(
        (candidate) => candidate.id === input.cityId,
      );
      if (!city) throw new NotFoundError("affair city", input.cityId);
    }
  }
}

export class InMemoryAffairReceiptAccessLog implements AffairReceiptAccessLog {
  readonly events: AffairReceiptAccessEvent[] = [];
  failActions = new Set<AffairReceiptAccessEvent["action"]>();

  async record(event: AffairReceiptAccessEvent): Promise<void> {
    if (this.failActions.has(event.action)) {
      throw new Error(`simulated ${event.action} audit failure`);
    }
    this.events.push(copy(event));
  }
}

export const createInMemoryAffairReceiptRepository = (
  affairs: AffairRepository,
): AffairReceiptRepository => new InMemoryAffairReceiptRepository(affairs);