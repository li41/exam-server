import { randomUUID } from "node:crypto";
import {
  AffairReceiptPositionSchema,
} from "@server-foundation/api-contracts";
import type {
  AffairReceiptDetail,
  AffairReceiptListItem,
  AffairReceiptListQuery,
  AffairReceiptSelectionInput,
  CreateAffairReceiptInput,
  Page,
  UpdateAffairReceiptInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  AffairReceiptAccessEvent,
  AffairReceiptAccessLog,
  AffairReceiptRepository,
  QuestionBankScope,
} from "@server-foundation/domain";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { decodeItemCursor, encodeItemCursor } from "./cursor.js";
import type { SensitiveFieldProtector } from "./examinee-credential-protector.js";

type SafeReceiptRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  affair_id: string;
  submitter_type: "school" | "city";
  school_id: string | null;
  city_id: string | null;
  account_type: string;
  account: string;
  name: string;
  positions: unknown;
  monitor_classes: number | null;
  briefing_region: AffairReceiptListItem["briefingRegion"];
  transport_type: AffairReceiptListItem["transportType"];
  transport_fee: number | null;
  agreed: number | boolean;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type DetailReceiptRow = SafeReceiptRow & {
  job_title: string;
  id_number: string;
  resident_cert: string | null;
  tax_id: string | null;
  phone_area: string;
  phone_number: string;
  phone_ext: string | null;
  mobile: string;
  email: string;
  addr_city: string;
  addr_district: string;
  addr_detail: string;
  bank_id: string;
  bank_subid: string;
  bank_account: string;
  bankbook_file_id: string;
  transport_origin_area: string | null;
  transport_origin_station: string | null;
  transport_dest_station: string | null;
};

type VersionRow = RowDataPacket & { version: number };
type IdRow = RowDataPacket & { id: string };
type SqlValue = string | number | boolean | Date | null;

const safeColumns = `
  r.id, r.tenant_id, r.affair_id, r.submitter_type, r.school_id, r.city_id,
  r.account_type, r.account, r.name, r.positions, r.monitor_classes,
  r.briefing_region, r.transport_type, r.transport_fee, r.agreed, r.version,
  r.created_at, r.updated_at`;

const detailColumns = `${safeColumns},
  r.job_title, r.id_number, r.resident_cert, r.tax_id, r.phone_area,
  r.phone_number, r.phone_ext, r.mobile, r.email, r.addr_city,
  r.addr_district, r.addr_detail, r.bank_id, r.bank_subid, r.bank_account,
  r.bankbook_file_id, r.transport_origin_area, r.transport_origin_station,
  r.transport_dest_station`;

const toIso = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value.replace(" ", "T") : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) throw new Error("MySQL returned an invalid affair receipt date.");
  return date.toISOString();
};

const parsePositions = (value: unknown): AffairReceiptListItem["positions"] => {
  let parsed = value;
  if (typeof value === "string") parsed = JSON.parse(value) as unknown;
  return AffairReceiptPositionSchema.array().parse(parsed);
};

const isDuplicate = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";

const normalizeIdNumber = (value: string): string => value.trim().toUpperCase();

const encryptedUpdateColumns = {
  jobTitle: "job_title",
  idNumber: "id_number",
  residentCert: "resident_cert",
  taxId: "tax_id",
  phoneArea: "phone_area",
  phoneNumber: "phone_number",
  phoneExt: "phone_ext",
  mobile: "mobile",
  email: "email",
  addrCity: "addr_city",
  addrDistrict: "addr_district",
  addrDetail: "addr_detail",
  bankAccount: "bank_account",
} as const;

const plainUpdateColumns = {
  name: "name",
  bankId: "bank_id",
  bankSubid: "bank_subid",
  bankbookFileId: "bankbook_file_id",
  monitorClasses: "monitor_classes",
  briefingRegion: "briefing_region",
  transportType: "transport_type",
  transportOriginArea: "transport_origin_area",
  transportOriginStation: "transport_origin_station",
  transportDestStation: "transport_dest_station",
  transportFee: "transport_fee",
  agreed: "agreed",
} as const;

export class MySqlAffairReceiptRepository implements AffairReceiptRepository {
  constructor(
    private readonly pool: Pool,
    private readonly protector: SensitiveFieldProtector,
  ) {}

  async listReceipts(
    query: AffairReceiptListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<AffairReceiptListItem>> {
    const predicates = ["r.tenant_id = ?", "r.affair_id = ?"];
    const params: SqlValue[] = [scope.tenantId, query.affairId];
    if (query.submitterType) {
      predicates.push("r.submitter_type = ?");
      params.push(query.submitterType);
    }
    if (query.keyword) {
      predicates.push("(r.name LIKE ? OR r.account LIKE ? OR r.id_number_bidx = ?)");
      params.push(`%${query.keyword}%`, `%${query.keyword}%`, this.protector.digest(normalizeIdNumber(query.keyword)));
    }
    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      predicates.push("(r.updated_at < ? OR (r.updated_at = ? AND r.id < ?))");
      params.push(new Date(cursor.updatedAt), new Date(cursor.updatedAt), cursor.id);
    }
    const [rows] = await this.pool.execute<SafeReceiptRow[]>(
      `SELECT ${safeColumns}
       FROM affair_receipts r
       WHERE ${predicates.join(" AND ")}
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT ?`,
      [...params, query.limit + 1],
    );
    const visible = rows.slice(0, query.limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => this.toListItem(row)),
      page: {
        nextCursor:
          rows.length > query.limit && last
            ? encodeItemCursor({ updatedAt: toIso(last.updated_at), id: last.id })
            : null,
      },
    };
  }

  async getReceipt(id: string, scope: QuestionBankScope): Promise<AffairReceiptDetail | null> {
    const [rows] = await this.pool.execute<DetailReceiptRow[]>(
      `SELECT ${detailColumns}
       FROM affair_receipts r
       WHERE r.id = ? AND r.tenant_id = ? LIMIT 1`,
      [id, scope.tenantId],
    );
    return rows[0] ? this.toDetail(rows[0]) : null;
  }

  async createReceipt(
    input: CreateAffairReceiptInput,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail> {
    await this.assertParents(input, scope);
    const id = randomUUID();
    const now = new Date();
    const protectedValues = this.protectInput(input);
    try {
      await this.pool.execute(
        `INSERT INTO affair_receipts (
          id, tenant_id, affair_id, submitter_type, school_id, city_id,
          account_type, account, name, job_title, id_number, id_number_bidx,
          resident_cert, tax_id, phone_area, phone_number, phone_ext, mobile,
          email, addr_city, addr_district, addr_detail, bank_id, bank_subid,
          bank_account, bankbook_file_id, positions, monitor_classes,
          briefing_region, transport_type, transport_origin_area,
          transport_origin_station, transport_dest_station, transport_fee,
          agreed, version, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
        )`,
        [
          id,
          scope.tenantId,
          input.affairId,
          input.submitterType,
          input.submitterType === "school" ? input.schoolId : null,
          input.submitterType === "city" ? input.cityId : null,
          input.accountType,
          input.account,
          input.name,
          protectedValues.jobTitle,
          protectedValues.idNumber,
          this.protector.digest(normalizeIdNumber(input.idNumber)),
          protectedValues.residentCert,
          protectedValues.taxId,
          protectedValues.phoneArea,
          protectedValues.phoneNumber,
          protectedValues.phoneExt,
          protectedValues.mobile,
          protectedValues.email,
          protectedValues.addrCity,
          protectedValues.addrDistrict,
          protectedValues.addrDetail,
          input.bankId,
          input.bankSubid,
          protectedValues.bankAccount,
          input.bankbookFileId,
          JSON.stringify(input.positions),
          input.monitorClasses,
          input.briefingRegion,
          input.transportType,
          input.transportOriginArea,
          input.transportOriginStation,
          input.transportDestStation,
          input.transportFee,
          input.agreed,
          now,
          now,
        ],
      );
    } catch (error) {
      if (isDuplicate(error)) {
        throw new ConflictError("A receipt already exists for this affair account.");
      }
      throw error;
    }
    const created = await this.getReceipt(id, scope);
    if (!created) throw new Error("Affair receipt insert succeeded but could not be read.");
    return created;
  }

  async updateReceipt(
    id: string,
    input: UpdateAffairReceiptInput,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail> {
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, column] of Object.entries(encryptedUpdateColumns) as Array<[
      keyof typeof encryptedUpdateColumns,
      string,
    ]>) {
      const value = input[key as keyof UpdateAffairReceiptInput];
      if (value !== undefined) {
        assignments.push(`${column} = ?`);
        params.push(value === null ? null : this.protector.protect(String(value)));
        if (key === "idNumber") {
          assignments.push("id_number_bidx = ?");
          params.push(this.protector.digest(normalizeIdNumber(String(value))));
        }
      }
    }
    for (const [key, column] of Object.entries(plainUpdateColumns) as Array<[
      keyof typeof plainUpdateColumns,
      string,
    ]>) {
      const value = input[key as keyof UpdateAffairReceiptInput];
      if (value !== undefined) {
        assignments.push(`${column} = ?`);
        params.push(value as SqlValue);
      }
    }
    if (input.positions !== undefined) {
      assignments.push("positions = ?");
      params.push(JSON.stringify(input.positions));
    }
    if (assignments.length === 0) return this.requireReceipt(id, scope);
    assignments.push("version = version + 1", "updated_at = ?");
    params.push(new Date(), id, scope.tenantId, input.version);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE affair_receipts
       SET ${assignments.join(", ")}
       WHERE id = ? AND tenant_id = ? AND version = ?`,
      params,
    );
    if (result.affectedRows === 0) await this.throwVersionFailure(id, input.version, scope);
    return this.requireReceipt(id, scope);
  }

  async lookupByIdNumber(
    affairId: string,
    idNumber: string,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail | null> {
    const [rows] = await this.pool.execute<DetailReceiptRow[]>(
      `SELECT ${detailColumns}
       FROM affair_receipts r
       WHERE r.tenant_id = ? AND r.affair_id = ? AND r.id_number_bidx = ?
       ORDER BY r.created_at DESC LIMIT 1`,
      [scope.tenantId, affairId, this.protector.digest(normalizeIdNumber(idNumber))],
    );
    return rows[0] ? this.toDetail(rows[0]) : null;
  }

  async selectReceipts(
    input: AffairReceiptSelectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairReceiptDetail[]> {
    const params: SqlValue[] = [scope.tenantId, input.affairId];
    let idPredicate = "";
    if (input.ids.length > 0) {
      idPredicate = ` AND r.id IN (${input.ids.map(() => "?").join(", ")})`;
      params.push(...input.ids);
    }
    const [rows] = await this.pool.execute<DetailReceiptRow[]>(
      `SELECT ${detailColumns}
       FROM affair_receipts r
       WHERE r.tenant_id = ? AND r.affair_id = ?${idPredicate}
       ORDER BY r.created_at DESC, r.id DESC`,
      params,
    );
    return rows.map((row) => this.toDetail(row));
  }

  async deleteReceipt(id: string, version: number, scope: QuestionBankScope): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "DELETE FROM affair_receipts WHERE id = ? AND tenant_id = ? AND version = ?",
      [id, scope.tenantId, version],
    );
    if (result.affectedRows === 0) await this.throwVersionFailure(id, version, scope);
  }

  private async assertParents(input: CreateAffairReceiptInput, scope: QuestionBankScope): Promise<void> {
    const [affairs] = await this.pool.execute<IdRow[]>(
      "SELECT id FROM affairs WHERE id = ? AND tenant_id = ? LIMIT 1",
      [input.affairId, scope.tenantId],
    );
    if (!affairs[0]) throw new NotFoundError("affair", input.affairId);
    if (input.submitterType === "school") {
      const [schools] = await this.pool.execute<IdRow[]>(
        "SELECT id FROM affair_schools WHERE id = ? AND affair_id = ? AND tenant_id = ? LIMIT 1",
        [input.schoolId, input.affairId, scope.tenantId],
      );
      if (!schools[0]) throw new NotFoundError("affair school", input.schoolId);
    } else {
      const [cities] = await this.pool.execute<IdRow[]>(
        "SELECT id FROM affair_cities WHERE id = ? AND tenant_id = ? LIMIT 1",
        [input.cityId, scope.tenantId],
      );
      if (!cities[0]) throw new NotFoundError("affair city", input.cityId);
    }
  }

  private protectInput(input: CreateAffairReceiptInput) {
    const protectNullable = (value: string | null): string | null =>
      value === null ? null : this.protector.protect(value);
    return {
      jobTitle: this.protector.protect(input.jobTitle),
      idNumber: this.protector.protect(normalizeIdNumber(input.idNumber)),
      residentCert: protectNullable(input.residentCert),
      taxId: protectNullable(input.taxId),
      phoneArea: this.protector.protect(input.phoneArea),
      phoneNumber: this.protector.protect(input.phoneNumber),
      phoneExt: protectNullable(input.phoneExt),
      mobile: this.protector.protect(input.mobile),
      email: this.protector.protect(input.email),
      addrCity: this.protector.protect(input.addrCity),
      addrDistrict: this.protector.protect(input.addrDistrict),
      addrDetail: this.protector.protect(input.addrDetail),
      bankAccount: this.protector.protect(input.bankAccount),
    };
  }

  private toListItem(row: SafeReceiptRow): AffairReceiptListItem {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      affairId: row.affair_id,
      submitterType: row.submitter_type,
      schoolId: row.school_id,
      cityId: row.city_id,
      accountType: row.account_type,
      account: row.account,
      name: row.name,
      positions: parsePositions(row.positions),
      monitorClasses: row.monitor_classes === null ? null : Number(row.monitor_classes),
      briefingRegion: row.briefing_region,
      transportType: row.transport_type,
      transportFee: row.transport_fee === null ? null : Number(row.transport_fee),
      agreed: Boolean(row.agreed),
      version: Number(row.version),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private toDetail(row: DetailReceiptRow): AffairReceiptDetail {
    return {
      ...this.toListItem(row),
      jobTitle: this.protector.unprotect(row.job_title),
      idNumber: this.protector.unprotect(row.id_number),
      residentCert: row.resident_cert === null ? null : this.protector.unprotect(row.resident_cert),
      taxId: row.tax_id === null ? null : this.protector.unprotect(row.tax_id),
      phoneArea: this.protector.unprotect(row.phone_area),
      phoneNumber: this.protector.unprotect(row.phone_number),
      phoneExt: row.phone_ext === null ? null : this.protector.unprotect(row.phone_ext),
      mobile: this.protector.unprotect(row.mobile),
      email: this.protector.unprotect(row.email),
      addrCity: this.protector.unprotect(row.addr_city),
      addrDistrict: this.protector.unprotect(row.addr_district),
      addrDetail: this.protector.unprotect(row.addr_detail),
      bankId: row.bank_id,
      bankSubid: row.bank_subid,
      bankAccount: this.protector.unprotect(row.bank_account),
      bankbookFileId: row.bankbook_file_id,
      transportOriginArea: row.transport_origin_area,
      transportOriginStation: row.transport_origin_station,
      transportDestStation: row.transport_dest_station,
    };
  }

  private async requireReceipt(id: string, scope: QuestionBankScope): Promise<AffairReceiptDetail> {
    const receipt = await this.getReceipt(id, scope);
    if (!receipt) throw new NotFoundError("affair receipt", id);
    return receipt;
  }

  private async throwVersionFailure(id: string, version: number, scope: QuestionBankScope): Promise<never> {
    const [rows] = await this.pool.execute<VersionRow[]>(
      "SELECT version FROM affair_receipts WHERE id = ? AND tenant_id = ? LIMIT 1",
      [id, scope.tenantId],
    );
    if (!rows[0]) throw new NotFoundError("affair receipt", id);
    if (Number(rows[0].version) !== version) {
      throw new ConflictError("affair receipt was modified by another request.");
    }
    throw new Error("Affair receipt operation did not affect the expected row.");
  }
}

export class MySqlAffairReceiptAccessLog implements AffairReceiptAccessLog {
  constructor(private readonly pool: Pool) {}

  async record(event: AffairReceiptAccessEvent): Promise<void> {
    await this.pool.execute(
      `INSERT INTO affair_receipt_access_logs (
        tenant_id, affair_id, actor_type, actor_user_id, actor_account,
        action, receipt_id, record_count, ip, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.tenantId,
        event.affairId,
        event.actorType,
        event.actorUserId,
        event.actorAccount,
        event.action,
        event.receiptId,
        event.recordCount,
        event.ip,
        event.createdAt ? new Date(event.createdAt) : new Date(),
      ],
    );
  }
}
