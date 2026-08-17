import { randomUUID } from "node:crypto";
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
import {
  ConflictError,
  DomainError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  AffairRepository,
  QuestionBankScope,
} from "@server-foundation/domain";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { decodeItemCursor, encodeItemCursor } from "./cursor.js";

const cityList = [
  ["01", "臺北市"], ["02", "新北市"], ["03", "桃園市"], ["04", "臺中市"],
  ["05", "臺南市"], ["06", "高雄市"], ["07", "基隆市"], ["08", "新竹市"],
  ["09", "新竹縣"], ["10", "苗栗縣"], ["11", "彰化縣"], ["12", "南投縣"],
  ["13", "雲林縣"], ["14", "嘉義市"], ["15", "嘉義縣"], ["16", "屏東縣"],
  ["17", "宜蘭縣"], ["18", "花蓮縣"], ["19", "臺東縣"], ["20", "澎湖縣"],
  ["21", "金門縣"], ["22", "連江縣"],
] as const;

type AffairRow = RowDataPacket & {
  id: string; tenant_id: string; created_by: string; name: string;
  description: string | null; status: Affair["status"];
  city_login_start: Date | string | null; city_login_end: Date | string | null;
  school_login_start: Date | string | null; school_login_end: Date | string | null;
  fee_city_contact: number; fee_school_contact: number; fee_teacher_setup: number;
  fee_teacher_monitor_1: number; fee_teacher_monitor_2: number; fee_teacher_monitor_3: number;
  transport_receipt_school: number; transport_receipt_city: number;
  briefing_regions: unknown; receipt_year: string | null; receipt_note: string | null;
  receipt_print_school: number; receipt_print_city: number; version: number;
  created_at: Date | string; updated_at: Date | string;
};
type CityRow = RowDataPacket & {
  id: string; tenant_id: string; city_code: string; city_name: string;
  account: string; password: string; contact_name: string | null; email: string | null;
  phone: string | null; setup_completed: number; version: number;
  created_at: Date | string; updated_at: Date | string;
};
type SchoolRow = RowDataPacket & {
  id: string; affair_id: string; tenant_id: string; city: string; school_level: 1 | 2 | 3;
  school_code: string; school_name: string; test_classes: 1 | 2; test_sessions: 1 | 2 | 3;
  receipt_code: string | null; briefing_options: unknown; password: string;
  contacts: unknown; setup_completed: unknown; status: AffairSchool["status"]; version: number;
  created_at: Date | string; updated_at: Date | string;
};
type VersionRow = RowDataPacket & { version: number };

type SqlValue = string | number | Date | null;

const affairColumns = `a.id, a.tenant_id, a.created_by, a.name, a.description, a.status,
 a.city_login_start, a.city_login_end, a.school_login_start, a.school_login_end,
 a.fee_city_contact, a.fee_school_contact, a.fee_teacher_setup,
 a.fee_teacher_monitor_1, a.fee_teacher_monitor_2, a.fee_teacher_monitor_3,
 a.transport_receipt_school, a.transport_receipt_city, a.briefing_regions,
 a.receipt_year, a.receipt_note, a.receipt_print_school, a.receipt_print_city,
 a.version, a.created_at, a.updated_at`;
const schoolColumns = `s.id, s.affair_id, s.tenant_id, s.city, s.school_level,
 s.school_code, s.school_name, s.test_classes, s.test_sessions, s.receipt_code,
 s.briefing_options, s.password, s.contacts, s.setup_completed, s.status,
 s.version, s.created_at, s.updated_at`;

const toIso = (value: Date | string | null): string | null => {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value.replace(" ", "T") : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) throw new Error("MySQL returned an invalid affair date.");
  return date.toISOString();
};
const parseJson = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value) as unknown; } catch { throw new Error("MySQL returned invalid affair JSON."); }
  }
  return value;
};
const encodeJson = (value: unknown): string | null => value === null || value === undefined ? null : JSON.stringify(value);
const escapeLike = (value: string): string => value.replace(/[!%_]/g, (character) => `!${character}`);
const isDuplicate = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
const validationError = (message: string): never => { throw new DomainError("validation_error", message); };

export class MySqlAffairRepository implements AffairRepository {
  constructor(private readonly pool: Pool) {}

  async listAffairs(query: AffairListQuery, scope: QuestionBankScope): Promise<Page<Affair>> {
    const predicates = ["a.tenant_id = ?"];
    const params: SqlValue[] = [scope.tenantId];
    if (query.search) { predicates.push("a.name LIKE ? ESCAPE '!'"); params.push(`%${escapeLike(query.search)}%`); }
    if (query.status) { predicates.push("a.status = ?"); params.push(query.status); }
    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      predicates.push("(a.updated_at < ? OR (a.updated_at = ? AND a.id < ?))");
      params.push(new Date(cursor.updatedAt), new Date(cursor.updatedAt), cursor.id);
    }
    const [rows] = await this.pool.execute<AffairRow[]>(
      `SELECT ${affairColumns} FROM affairs a WHERE ${predicates.join(" AND ")}
       ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`, [...params, query.limit + 1],
    );
    const hasNext = rows.length > query.limit;
    const visible = rows.slice(0, query.limit);
    const last = visible.at(-1);
    return { items: visible.map((row) => this.toAffair(row)), page: { nextCursor: hasNext && last ? encodeItemCursor({ updatedAt: toIso(last.updated_at) as string, id: last.id }) : null } };
  }

  async getAffair(id: string, scope: QuestionBankScope): Promise<Affair | null> {
    const [rows] = await this.pool.execute<AffairRow[]>(
      `SELECT ${affairColumns} FROM affairs a WHERE a.id = ? AND a.tenant_id = ? LIMIT 1`,
      [id, scope.tenantId],
    );
    return rows[0] ? this.toAffair(rows[0]) : null;
  }

  async createAffair(input: CreateAffairInput, scope: QuestionBankScope): Promise<Affair> {
    const id = randomUUID(); const now = new Date();
    await this.pool.execute(
      `INSERT INTO affairs (
        id, tenant_id, created_by, name, description, status,
        city_login_start, city_login_end, school_login_start, school_login_end,
        fee_city_contact, fee_school_contact, fee_teacher_setup, fee_teacher_monitor_1,
        fee_teacher_monitor_2, fee_teacher_monitor_3, transport_receipt_school,
        transport_receipt_city, briefing_regions, receipt_year, receipt_note,
        receipt_print_school, receipt_print_city, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, scope.tenantId, scope.actorUserId, input.name, input.description, input.status,
       input.cityLoginStart ? new Date(input.cityLoginStart) : null, input.cityLoginEnd ? new Date(input.cityLoginEnd) : null,
       input.schoolLoginStart ? new Date(input.schoolLoginStart) : null, input.schoolLoginEnd ? new Date(input.schoolLoginEnd) : null,
       input.feeCityContact, input.feeSchoolContact, input.feeTeacherSetup, input.feeTeacherMonitor1,
       input.feeTeacherMonitor2, input.feeTeacherMonitor3, input.transportReceiptSchool ? 1 : 0,
       input.transportReceiptCity ? 1 : 0, encodeJson(input.briefingRegions), input.receiptYear,
       input.receiptNote, input.receiptPrintSchool ? 1 : 0, input.receiptPrintCity ? 1 : 0, now, now],
    );
    const affair = await this.getAffair(id, scope);
    if (!affair) throw new Error("Affair insert succeeded but could not be read.");
    return affair;
  }

  async updateAffair(id: string, input: UpdateAffairInput, scope: QuestionBankScope): Promise<Affair> {
    const updates: string[] = []; const values: SqlValue[] = [];
    const put = (column: string, value: SqlValue) => { updates.push(`${column} = ?`); values.push(value); };
    if (input.name !== undefined) put("name", input.name);
    if (input.description !== undefined) put("description", input.description);
    if (input.status !== undefined) put("status", input.status);
    if (input.cityLoginStart !== undefined) put("city_login_start", input.cityLoginStart ? new Date(input.cityLoginStart) : null);
    if (input.cityLoginEnd !== undefined) put("city_login_end", input.cityLoginEnd ? new Date(input.cityLoginEnd) : null);
    if (input.schoolLoginStart !== undefined) put("school_login_start", input.schoolLoginStart ? new Date(input.schoolLoginStart) : null);
    if (input.schoolLoginEnd !== undefined) put("school_login_end", input.schoolLoginEnd ? new Date(input.schoolLoginEnd) : null);
    for (const [key, column] of [["feeCityContact","fee_city_contact"],["feeSchoolContact","fee_school_contact"],["feeTeacherSetup","fee_teacher_setup"],["feeTeacherMonitor1","fee_teacher_monitor_1"],["feeTeacherMonitor2","fee_teacher_monitor_2"],["feeTeacherMonitor3","fee_teacher_monitor_3"]] as const) if (input[key] !== undefined) put(column, input[key]);
    if (input.transportReceiptSchool !== undefined) put("transport_receipt_school", input.transportReceiptSchool ? 1 : 0);
    if (input.transportReceiptCity !== undefined) put("transport_receipt_city", input.transportReceiptCity ? 1 : 0);
    if (input.briefingRegions !== undefined) put("briefing_regions", encodeJson(input.briefingRegions));
    if (input.receiptYear !== undefined) put("receipt_year", input.receiptYear);
    if (input.receiptNote !== undefined) put("receipt_note", input.receiptNote);
    if (input.receiptPrintSchool !== undefined) put("receipt_print_school", input.receiptPrintSchool ? 1 : 0);
    if (input.receiptPrintCity !== undefined) put("receipt_print_city", input.receiptPrintCity ? 1 : 0);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE affairs SET ${updates.length ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND version = ?`, [...values, new Date(), id, scope.tenantId, input.version],
    );
    if (result.affectedRows === 0) await this.throwVersionFailure("affairs", "affair", id, input.version, scope);
    return (await this.getAffair(id, scope)) as Affair;
  }

  async listCities(scope: QuestionBankScope): Promise<AffairCity[]> {
    const [rows] = await this.pool.execute<CityRow[]>(
      `SELECT id, tenant_id, city_code, city_name, account, password, contact_name,
       email, phone, setup_completed, version, created_at, updated_at
       FROM affair_cities WHERE tenant_id = ? ORDER BY city_code`, [scope.tenantId],
    );
    return rows.map((row) => this.toCity(row));
  }

  async initializeCities(scope: QuestionBankScope): Promise<{ created: number; items: AffairCity[] }> {
    let created = 0;
    for (const [code, name] of cityList) {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `INSERT IGNORE INTO affair_cities
         (id, tenant_id, city_code, city_name, account, password, setup_completed, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
        [randomUUID(), scope.tenantId, code, name, `EDU${code}`, `EDU${code}`, new Date(), new Date()],
      );
      created += result.affectedRows;
    }
    return { created, items: await this.listCities(scope) };
  }

  async updateCity(id: string, input: UpdateAffairCityInput, scope: QuestionBankScope): Promise<AffairCity> {
    const updates: string[] = []; const values: SqlValue[] = [];
    const put = (column: string, value: SqlValue) => { updates.push(`${column} = ?`); values.push(value); };
    if (input.password !== undefined) put("password", input.password);
    if (input.contactName !== undefined) put("contact_name", input.contactName);
    if (input.email !== undefined) put("email", input.email);
    if (input.phone !== undefined) put("phone", input.phone);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE affair_cities SET ${updates.length ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND version = ?`, [...values, new Date(), id, scope.tenantId, input.version],
    );
    if (result.affectedRows === 0) await this.throwVersionFailure("affair_cities", "affair city", id, input.version, scope);
    const [rows] = await this.pool.execute<CityRow[]>(
      `SELECT id, tenant_id, city_code, city_name, account, password, contact_name,
       email, phone, setup_completed, version, created_at, updated_at
       FROM affair_cities WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, scope.tenantId],
    );
    if (!rows[0]) throw new NotFoundError("affair city", id);
    return this.toCity(rows[0]);
  }

  async listSchools(query: AffairSchoolListQuery, scope: QuestionBankScope): Promise<Page<AffairSchool>> {
    await this.assertAffair(query.affairId, scope);
    const predicates = ["s.tenant_id = ?", "s.affair_id = ?"];
    const params: SqlValue[] = [scope.tenantId, query.affairId];
    if (query.city) { predicates.push("s.city = ?"); params.push(query.city); }
    if (query.schoolLevel) { predicates.push("s.school_level = ?"); params.push(query.schoolLevel); }
    if (query.status) { predicates.push("s.status = ?"); params.push(query.status); }
    if (query.search) { predicates.push("(s.school_code LIKE ? ESCAPE '!' OR s.school_name LIKE ? ESCAPE '!')"); const q = `%${escapeLike(query.search)}%`; params.push(q, q); }
    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor); if (!cursor) throw new InvalidCursorError();
      predicates.push("(s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))");
      params.push(new Date(cursor.updatedAt), new Date(cursor.updatedAt), cursor.id);
    }
    const [rows] = await this.pool.execute<SchoolRow[]>(
      `SELECT ${schoolColumns} FROM affair_schools s WHERE ${predicates.join(" AND ")}
       ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`, [...params, query.limit + 1],
    );
    const hasNext = rows.length > query.limit; const visible = rows.slice(0, query.limit); const last = visible.at(-1);
    return { items: visible.map((row) => this.toSchool(row)), page: { nextCursor: hasNext && last ? encodeItemCursor({ updatedAt: toIso(last.updated_at) as string, id: last.id }) : null } };
  }

  async getSchool(id: string, scope: QuestionBankScope): Promise<AffairSchool | null> {
    const [rows] = await this.pool.execute<SchoolRow[]>(
      `SELECT ${schoolColumns} FROM affair_schools s WHERE s.id = ? AND s.tenant_id = ? LIMIT 1`, [id, scope.tenantId],
    );
    return rows[0] ? this.toSchool(rows[0]) : null;
  }

  async createSchool(input: CreateAffairSchoolInput, scope: QuestionBankScope): Promise<AffairSchool> {
    await this.assertAffair(input.affairId, scope);
    const id = randomUUID(); const now = new Date();
    try {
      await this.pool.execute(
        `INSERT INTO affair_schools
         (id, affair_id, tenant_id, city, school_level, school_code, school_name,
          test_classes, test_sessions, receipt_code, briefing_options, password,
          contacts, setup_completed, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, ?, ?)`,
        [id, input.affairId, scope.tenantId, input.city, input.schoolLevel, input.schoolCode,
         input.schoolName, input.testClasses, input.testSessions, input.receiptCode,
         encodeJson(input.briefingOptions), input.password || input.schoolCode, input.status, now, now],
      );
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictError("A school with the same code and level already exists in this affair.");
      throw error;
    }
    const school = await this.getSchool(id, scope);
    if (!school) throw new Error("Affair school insert succeeded but could not be read.");
    return school;
  }

  async updateSchool(id: string, input: UpdateAffairSchoolInput, scope: QuestionBankScope): Promise<AffairSchool> {
    const updates: string[] = []; const values: SqlValue[] = [];
    const put = (column: string, value: SqlValue) => { updates.push(`${column} = ?`); values.push(value); };
    if (input.city !== undefined) put("city", input.city);
    if (input.schoolLevel !== undefined) put("school_level", input.schoolLevel);
    if (input.schoolCode !== undefined) put("school_code", input.schoolCode);
    if (input.schoolName !== undefined) put("school_name", input.schoolName);
    if (input.testClasses !== undefined) put("test_classes", input.testClasses);
    if (input.testSessions !== undefined) put("test_sessions", input.testSessions);
    if (input.receiptCode !== undefined) put("receipt_code", input.receiptCode);
    if (input.briefingOptions !== undefined) put("briefing_options", encodeJson(input.briefingOptions));
    if (input.password !== undefined && input.password !== null) put("password", input.password);
    if (input.status !== undefined) put("status", input.status);
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE affair_schools SET ${updates.length ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND version = ?`, [...values, new Date(), id, scope.tenantId, input.version],
      );
      if (result.affectedRows === 0) await this.throwVersionFailure("affair_schools", "affair school", id, input.version, scope);
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictError("A school with the same code and level already exists in this affair.");
      throw error;
    }
    return (await this.getSchool(id, scope)) as AffairSchool;
  }

  async deleteSchool(id: string, version: number, scope: QuestionBankScope): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM affair_schools WHERE id = ? AND tenant_id = ? AND version = ?`, [id, scope.tenantId, version],
    );
    if (result.affectedRows === 0) await this.throwVersionFailure("affair_schools", "affair school", id, version, scope);
  }

  private async assertAffair(id: string, scope: QuestionBankScope): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT id FROM affairs WHERE id = ? AND tenant_id = ? LIMIT 1", [id, scope.tenantId]);
    if (!rows[0]) throw new NotFoundError("affair", id);
  }

  private async throwVersionFailure(table: "affairs" | "affair_cities" | "affair_schools", resource: string, id: string, version: number, scope: QuestionBankScope): Promise<never> {
    const [rows] = await this.pool.execute<VersionRow[]>(`SELECT version FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`, [id, scope.tenantId]);
    if (!rows[0]) throw new NotFoundError(resource, id);
    if (Number(rows[0].version) !== version) throw new ConflictError(`${resource} was modified by another request.`);
    throw new Error(`${resource} update did not affect the expected row.`);
  }

  private toAffair(row: AffairRow): Affair {
    return { id: row.id, tenantId: row.tenant_id, createdBy: row.created_by, name: row.name,
      description: row.description, status: row.status, cityLoginStart: toIso(row.city_login_start),
      cityLoginEnd: toIso(row.city_login_end), schoolLoginStart: toIso(row.school_login_start),
      schoolLoginEnd: toIso(row.school_login_end), feeCityContact: Number(row.fee_city_contact),
      feeSchoolContact: Number(row.fee_school_contact), feeTeacherSetup: Number(row.fee_teacher_setup),
      feeTeacherMonitor1: Number(row.fee_teacher_monitor_1), feeTeacherMonitor2: Number(row.fee_teacher_monitor_2),
      feeTeacherMonitor3: Number(row.fee_teacher_monitor_3), transportReceiptSchool: Boolean(row.transport_receipt_school),
      transportReceiptCity: Boolean(row.transport_receipt_city), briefingRegions: parseJson(row.briefing_regions),
      receiptYear: row.receipt_year, receiptNote: row.receipt_note, receiptPrintSchool: Boolean(row.receipt_print_school),
      receiptPrintCity: Boolean(row.receipt_print_city), version: Number(row.version), createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string };
  }
  private toCity(row: CityRow): AffairCity {
    return { id: row.id, tenantId: row.tenant_id, cityCode: row.city_code, cityName: row.city_name,
      account: row.account, password: row.password, contactName: row.contact_name, email: row.email,
      phone: row.phone, setupCompleted: Boolean(row.setup_completed), version: Number(row.version),
      createdAt: toIso(row.created_at) as string, updatedAt: toIso(row.updated_at) as string };
  }
  private toSchool(row: SchoolRow): AffairSchool {
    const briefing = parseJson(row.briefing_options); const setup = parseJson(row.setup_completed);
    return { id: row.id, tenantId: row.tenant_id, affairId: row.affair_id, city: row.city,
      schoolLevel: Number(row.school_level) as 1 | 2 | 3, schoolCode: row.school_code, schoolName: row.school_name,
      testClasses: Number(row.test_classes) as 1 | 2, testSessions: Number(row.test_sessions) as 1 | 2 | 3,
      receiptCode: row.receipt_code, briefingOptions: Array.isArray(briefing) ? briefing.map(String) : null,
      password: row.password, contacts: parseJson(row.contacts), setupCompleted: Array.isArray(setup) ? setup.filter((v): v is "SC" | "SD" | "SE" => v === "SC" || v === "SD" || v === "SE") : null,
      status: row.status, version: Number(row.version), createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string };
  }
}
