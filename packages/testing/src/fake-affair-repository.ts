import type {
  Affair,
  AffairCity,
  AffairListQuery,
  AffairSchool,
  AffairSchoolListQuery,
  CreateAffairInput,
  CreateAffairSchoolInput,
  Page,
  UpdateAffairCityInput,
  UpdateAffairInput,
  UpdateAffairSchoolInput,
} from "@server-foundation/api-contracts";
import { ConflictError, NotFoundError } from "@server-foundation/domain";
import type { AffairRepository, QuestionBankScope } from "@server-foundation/domain";

const cities = [
  ["01", "臺北市"], ["02", "新北市"], ["03", "桃園市"], ["04", "臺中市"],
  ["05", "臺南市"], ["06", "高雄市"], ["07", "基隆市"], ["08", "新竹市"],
  ["09", "新竹縣"], ["10", "苗栗縣"], ["11", "彰化縣"], ["12", "南投縣"],
  ["13", "雲林縣"], ["14", "嘉義市"], ["15", "嘉義縣"], ["16", "屏東縣"],
  ["17", "宜蘭縣"], ["18", "花蓮縣"], ["19", "臺東縣"], ["20", "澎湖縣"],
  ["21", "金門縣"], ["22", "連江縣"],
] as const;

const randomUUID = (): string => globalThis.crypto.randomUUID();
const now = (): string => new Date().toISOString();
const page = <T>(items: T[], limit: number): Page<T> => ({
  items: items.slice(0, limit),
  page: { nextCursor: null },
});

class InMemoryAffairRepository implements AffairRepository {
  private readonly affairs: Affair[] = [];
  private readonly cityRows: AffairCity[] = [];
  private readonly schools: AffairSchool[] = [];

  async listAffairs(query: AffairListQuery, scope: QuestionBankScope): Promise<Page<Affair>> {
    const search = query.search?.toLocaleLowerCase();
    return page(
      this.affairs.filter((item) =>
        item.tenantId === scope.tenantId &&
        (!query.status || item.status === query.status) &&
        (!search || item.name.toLocaleLowerCase().includes(search)),
      ),
      query.limit,
    );
  }

  async getAffair(id: string, scope: QuestionBankScope): Promise<Affair | null> {
    return this.affairs.find((item) => item.id === id && item.tenantId === scope.tenantId) ?? null;
  }

  async createAffair(input: CreateAffairInput, scope: QuestionBankScope): Promise<Affair> {
    const timestamp = now();
    const item: Affair = {
      id: randomUUID(), tenantId: scope.tenantId, createdBy: scope.actorUserId,
      ...input, version: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    this.affairs.push(item);
    return item;
  }

  async updateAffair(id: string, input: UpdateAffairInput, scope: QuestionBankScope): Promise<Affair> {
    const index = this.affairs.findIndex((item) => item.id === id && item.tenantId === scope.tenantId);
    if (index < 0) throw new NotFoundError("affair", id);
    const current = this.affairs[index] as Affair;
    if (current.version !== input.version) throw new ConflictError("affair was modified by another request.");
    const { version: _version, ...changes } = input;
    const updated = { ...current, ...changes, version: current.version + 1, updatedAt: now() };
    this.affairs[index] = updated;
    return updated;
  }

  async listCities(scope: QuestionBankScope): Promise<AffairCity[]> {
    return this.cityRows.filter((item) => item.tenantId === scope.tenantId).sort((a, b) => a.cityCode.localeCompare(b.cityCode));
  }

  async initializeCities(scope: QuestionBankScope): Promise<{ created: number; items: AffairCity[] }> {
    let created = 0;
    for (const [code, name] of cities) {
      if (this.cityRows.some((item) => item.tenantId === scope.tenantId && item.cityCode === code)) continue;
      const timestamp = now();
      this.cityRows.push({
        id: randomUUID(), tenantId: scope.tenantId, cityCode: code, cityName: name,
        account: `EDU${code}`, password: `EDU${code}`, contactName: null, email: null,
        phone: null, setupCompleted: false, version: 1, createdAt: timestamp, updatedAt: timestamp,
      });
      created++;
    }
    return { created, items: await this.listCities(scope) };
  }

  async updateCity(id: string, input: UpdateAffairCityInput, scope: QuestionBankScope): Promise<AffairCity> {
    const index = this.cityRows.findIndex((item) => item.id === id && item.tenantId === scope.tenantId);
    if (index < 0) throw new NotFoundError("affair city", id);
    const current = this.cityRows[index] as AffairCity;
    if (current.version !== input.version) throw new ConflictError("affair city was modified by another request.");
    const { version: _version, ...changes } = input;
    const updated = { ...current, ...changes, version: current.version + 1, updatedAt: now() };
    this.cityRows[index] = updated;
    return updated;
  }

  async listSchools(query: AffairSchoolListQuery, scope: QuestionBankScope): Promise<Page<AffairSchool>> {
    if (!(await this.getAffair(query.affairId, scope))) throw new NotFoundError("affair", query.affairId);
    const search = query.search?.toLocaleLowerCase();
    return page(
      this.schools.filter((item) => item.tenantId === scope.tenantId && item.affairId === query.affairId &&
        (!query.city || item.city === query.city) && (!query.schoolLevel || item.schoolLevel === query.schoolLevel) &&
        (!query.status || item.status === query.status) &&
        (!search || item.schoolCode.toLocaleLowerCase().includes(search) || item.schoolName.toLocaleLowerCase().includes(search))),
      query.limit,
    );
  }

  async getSchool(id: string, scope: QuestionBankScope): Promise<AffairSchool | null> {
    return this.schools.find((item) => item.id === id && item.tenantId === scope.tenantId) ?? null;
  }

  async createSchool(input: CreateAffairSchoolInput, scope: QuestionBankScope): Promise<AffairSchool> {
    if (!(await this.getAffair(input.affairId, scope))) throw new NotFoundError("affair", input.affairId);
    if (this.schools.some((item) => item.tenantId === scope.tenantId && item.affairId === input.affairId && item.schoolLevel === input.schoolLevel && item.schoolCode === input.schoolCode)) {
      throw new ConflictError("A school with the same code and level already exists in this affair.");
    }
    const timestamp = now();
    const item: AffairSchool = {
      id: randomUUID(), tenantId: scope.tenantId, affairId: input.affairId, city: input.city,
      schoolLevel: input.schoolLevel, schoolCode: input.schoolCode, schoolName: input.schoolName,
      testClasses: input.testClasses, testSessions: input.testSessions, receiptCode: input.receiptCode,
      briefingOptions: input.briefingOptions, password: input.password || input.schoolCode,
      contacts: null, setupCompleted: null, status: input.status, version: 1,
      createdAt: timestamp, updatedAt: timestamp,
    };
    this.schools.push(item);
    return item;
  }

  async updateSchool(id: string, input: UpdateAffairSchoolInput, scope: QuestionBankScope): Promise<AffairSchool> {
    const index = this.schools.findIndex((item) => item.id === id && item.tenantId === scope.tenantId);
    if (index < 0) throw new NotFoundError("affair school", id);
    const current = this.schools[index] as AffairSchool;
    if (current.version !== input.version) throw new ConflictError("affair school was modified by another request.");
    const schoolLevel = input.schoolLevel ?? current.schoolLevel;
    const schoolCode = input.schoolCode ?? current.schoolCode;
    if (this.schools.some((item, candidateIndex) => candidateIndex !== index && item.tenantId === scope.tenantId && item.affairId === current.affairId && item.schoolLevel === schoolLevel && item.schoolCode === schoolCode)) {
      throw new ConflictError("A school with the same code and level already exists in this affair.");
    }
    const { version: _version, password, ...changes } = input;
    const updated = { ...current, ...changes, ...(password === undefined || password === null ? {} : { password }), version: current.version + 1, updatedAt: now() };
    this.schools[index] = updated;
    return updated;
  }

  async deleteSchool(id: string, version: number, scope: QuestionBankScope): Promise<void> {
    const index = this.schools.findIndex((item) => item.id === id && item.tenantId === scope.tenantId);
    if (index < 0) throw new NotFoundError("affair school", id);
    if ((this.schools[index] as AffairSchool).version !== version) throw new ConflictError("affair school was modified by another request.");
    this.schools.splice(index, 1);
  }
}

export const createInMemoryAffairRepository = (): AffairRepository => new InMemoryAffairRepository();