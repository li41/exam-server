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
import type { QuestionBankScope } from "./question-bank-repository.js";

export interface AffairRepository {
  listAffairs(query: AffairListQuery, scope: QuestionBankScope): Promise<Page<Affair>>;
  getAffair(id: string, scope: QuestionBankScope): Promise<Affair | null>;
  createAffair(input: CreateAffairInput, scope: QuestionBankScope): Promise<Affair>;
  updateAffair(
    id: string,
    input: UpdateAffairInput,
    scope: QuestionBankScope,
  ): Promise<Affair>;

  listCities(scope: QuestionBankScope): Promise<AffairCity[]>;
  initializeCities(
    scope: QuestionBankScope,
  ): Promise<{ created: number; items: AffairCity[] }>;
  updateCity(
    id: string,
    input: UpdateAffairCityInput,
    scope: QuestionBankScope,
  ): Promise<AffairCity>;

  listSchools(
    query: AffairSchoolListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<AffairSchool>>;
  getSchool(id: string, scope: QuestionBankScope): Promise<AffairSchool | null>;
  createSchool(
    input: CreateAffairSchoolInput,
    scope: QuestionBankScope,
  ): Promise<AffairSchool>;
  updateSchool(
    id: string,
    input: UpdateAffairSchoolInput,
    scope: QuestionBankScope,
  ): Promise<AffairSchool>;
  deleteSchool(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;
}
