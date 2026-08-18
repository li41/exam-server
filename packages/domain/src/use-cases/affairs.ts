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
import { NotFoundError } from "../errors.js";
import type { AffairRepository } from "../ports/affair-repository.js";
import type { QuestionBankScope } from "../ports/question-bank-repository.js";

export class AffairService {
  constructor(private readonly repository: AffairRepository) {}

  listAffairs(
    query: AffairListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Affair>> {
    return this.repository.listAffairs(query, scope);
  }

  async getAffair(id: string, scope: QuestionBankScope): Promise<Affair> {
    const affair = await this.repository.getAffair(id, scope);
    if (!affair) throw new NotFoundError("affair", id);
    return affair;
  }

  createAffair(
    input: CreateAffairInput,
    scope: QuestionBankScope,
  ): Promise<Affair> {
    return this.repository.createAffair(input, scope);
  }

  async updateAffair(
    id: string,
    input: UpdateAffairInput,
    scope: QuestionBankScope,
  ): Promise<Affair> {
    await this.getAffair(id, scope);
    return this.repository.updateAffair(id, input, scope);
  }

  listCities(scope: QuestionBankScope): Promise<AffairCity[]> {
    return this.repository.listCities(scope);
  }

  initializeCities(
    scope: QuestionBankScope,
  ): Promise<{ created: number; items: AffairCity[] }> {
    return this.repository.initializeCities(scope);
  }

  async updateCity(
    id: string,
    input: UpdateAffairCityInput,
    scope: QuestionBankScope,
  ): Promise<AffairCity> {
    const city = (await this.repository.listCities(scope)).find(
      (candidate) => candidate.id === id,
    );
    if (!city) throw new NotFoundError("affair city", id);
    return this.repository.updateCity(id, input, scope);
  }

  listSchools(
    query: AffairSchoolListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<AffairSchool>> {
    return this.repository.listSchools(query, scope);
  }

  async getSchool(id: string, scope: QuestionBankScope): Promise<AffairSchool> {
    const school = await this.repository.getSchool(id, scope);
    if (!school) throw new NotFoundError("affair school", id);
    return school;
  }

  createSchool(
    input: CreateAffairSchoolInput,
    scope: QuestionBankScope,
  ): Promise<AffairSchool> {
    return this.repository.createSchool(input, scope);
  }

  async updateSchool(
    id: string,
    input: UpdateAffairSchoolInput,
    scope: QuestionBankScope,
  ): Promise<AffairSchool> {
    await this.getSchool(id, scope);
    return this.repository.updateSchool(id, input, scope);
  }

  async deleteSchool(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getSchool(id, scope);
    await this.repository.deleteSchool(id, version, scope);
  }
}
