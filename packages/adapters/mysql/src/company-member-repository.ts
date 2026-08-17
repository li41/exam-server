import { randomUUID } from "node:crypto";
import {
  COMPANY_MEMBER_NO_PERMISSIONS,
  ConflictError,
  DomainError,
  NotFoundError,
  parseCompanyMemberPermissions,
} from "@server-foundation/domain";
import type {
  CompanyMember,
  CompanyMemberListQuery,
  CompanyMemberRepository,
  CompanyMemberReviewStatus,
  CompanyMemberScope,
  CompanyMemberStatus,
  CreateCompanyMemberInput,
  UpdateCompanyMemberInput,
} from "@server-foundation/domain";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

const memberColumns = `id, tenant_id, user_id, invited_email, is_admin,
  permissions, status, review_status, reviewed_by, reviewed_at, review_note,
  joined_at, updated_at, version`;

type CompanyMemberRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  user_id: string;
  invited_email: string | null;
  is_admin: number;
  permissions: unknown;
  status: number;
  review_status: number;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  review_note: string | null;
  joined_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type ExistingMemberRow = RowDataPacket & { id: string; version: number };
type CountRow = RowDataPacket & { total: number };
type UserRow = RowDataPacket & { id: string };

const toIso = (value: Date | string | null): string | null => {
  if (value === null) return null;
  const date =
    value instanceof Date
      ? value
      : new Date(
          /[zZ]|[+-]\d\d:?\d\d$/.test(value)
            ? value.replace(" ", "T")
            : `${value.replace(" ", "T")}Z`,
        );
  if (Number.isNaN(date.getTime()))
    throw new Error("MySQL returned an invalid date.");
  return date.toISOString();
};

const toStatus = (value: number): CompanyMemberStatus => {
  if (value === 0) return "disabled";
  if (value === 1) return "active";
  throw new Error(`MySQL returned invalid company member status ${value}.`);
};

const toReviewStatus = (value: number): CompanyMemberReviewStatus => {
  if (value === 0) return "pending";
  if (value === 1) return "approved";
  if (value === 2) return "rejected";
  throw new Error(
    `MySQL returned invalid company member review status ${value}.`,
  );
};

const statusValue = (value: CompanyMemberStatus): number =>
  value === "active" ? 1 : 0;

const reviewStatusValue = (value: CompanyMemberReviewStatus): number => {
  if (value === "pending") return 0;
  if (value === "approved") return 1;
  return 2;
};

const toPermissions = (value: unknown) => {
  if (value === null) return { ...COMPANY_MEMBER_NO_PERMISSIONS };
  if (typeof value === "string") {
    try {
      return parseCompanyMemberPermissions(JSON.parse(value));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          "MySQL returned invalid company member permissions JSON.",
        );
      }
      throw error;
    }
  }
  return parseCompanyMemberPermissions(value);
};

const toMember = (row: CompanyMemberRow): CompanyMember => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  invitedEmail: row.invited_email,
  isAdmin: row.is_admin === 1,
  permissions: toPermissions(row.permissions),
  status: toStatus(row.status),
  reviewStatus: toReviewStatus(row.review_status),
  reviewedBy: row.reviewed_by,
  reviewedAt: toIso(row.reviewed_at),
  reviewNote: row.review_note,
  joinedAt: toIso(row.joined_at) ?? "",
  updatedAt: toIso(row.updated_at) ?? "",
  version: row.version,
});

const escapeLike = (value: string): string =>
  value.replace(/[!%_]/g, (character) => `!${character}`);

const isDuplicateEntry = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ER_DUP_ENTRY";

export class MySqlCompanyMemberRepository implements CompanyMemberRepository {
  constructor(private readonly pool: Pool) {}

  async list(
    query: CompanyMemberListQuery,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember[]> {
    const predicates = ["tenant_id = ?"];
    const parameters: Array<string | number> = [scope.tenantId];
    if (query.status) {
      predicates.push("status = ?");
      parameters.push(statusValue(query.status));
    }
    if (query.reviewStatus) {
      predicates.push("review_status = ?");
      parameters.push(reviewStatusValue(query.reviewStatus));
    }
    if (query.search) {
      predicates.push(
        "(user_id LIKE ? ESCAPE '!' OR invited_email LIKE ? ESCAPE '!')",
      );
      const search = `%${escapeLike(query.search)}%`;
      parameters.push(search, search);
    }
    const [rows] = await this.pool.execute<CompanyMemberRow[]>(
      `SELECT ${memberColumns}
       FROM company_members
       WHERE ${predicates.join(" AND ")}
       ORDER BY is_admin DESC, review_status ASC, status DESC, joined_at ASC, id ASC`,
      parameters,
    );
    return rows.map(toMember);
  }

  async get(
    id: string,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember | null> {
    const [rows] = await this.pool.execute<CompanyMemberRow[]>(
      `SELECT ${memberColumns}
       FROM company_members
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`,
      [id, scope.tenantId],
    );
    return rows[0] ? toMember(rows[0]) : null;
  }

  async findByUserId(
    userId: string,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember | null> {
    const [rows] = await this.pool.execute<CompanyMemberRow[]>(
      `SELECT ${memberColumns}
       FROM company_members
       WHERE user_id = ? AND tenant_id = ?
       LIMIT 1`,
      [userId, scope.tenantId],
    );
    return rows[0] ? toMember(rows[0]) : null;
  }

  async create(
    input: CreateCompanyMemberInput,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember> {
    await this.assertUserInTenant(input.userId, scope);
    if (input.reviewedBy)
      await this.assertUserInTenant(input.reviewedBy, scope);
    const id = randomUUID();
    const now = new Date();
    try {
      await this.pool.execute(
        `INSERT INTO company_members
          (id, tenant_id, user_id, invited_email, is_admin, permissions,
           status, review_status, reviewed_by, reviewed_at, review_note,
           joined_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          id,
          scope.tenantId,
          input.userId,
          input.invitedEmail,
          input.isAdmin ? 1 : 0,
          JSON.stringify(input.permissions),
          statusValue(input.status),
          reviewStatusValue(input.reviewStatus),
          input.reviewedBy,
          input.reviewedBy ? now : null,
          input.reviewNote,
          now,
          now,
        ],
      );
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError("This user is already a member of the tenant.");
      }
      throw error;
    }
    const member = await this.get(id, scope);
    if (!member)
      throw new Error("MySQL member insert succeeded but could not be read.");
    return member;
  }

  async update(
    id: string,
    input: UpdateCompanyMemberInput,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember> {
    if (input.userId !== undefined)
      await this.assertUserInTenant(input.userId, scope);
    if (input.reviewedBy)
      await this.assertUserInTenant(input.reviewedBy, scope);

    const assignments: string[] = [];
    const parameters: Array<string | number | boolean | Date | null> = [];
    if (input.userId !== undefined) {
      assignments.push("user_id = ?");
      parameters.push(input.userId);
    }
    if (input.invitedEmail !== undefined) {
      assignments.push("invited_email = ?");
      parameters.push(input.invitedEmail);
    }
    if (input.isAdmin !== undefined) {
      assignments.push("is_admin = ?");
      parameters.push(input.isAdmin ? 1 : 0);
    }
    if (input.permissions !== undefined) {
      assignments.push("permissions = ?");
      parameters.push(JSON.stringify(input.permissions));
    }
    if (input.status !== undefined) {
      assignments.push("status = ?");
      parameters.push(statusValue(input.status));
    }
    if (input.reviewStatus !== undefined) {
      assignments.push("review_status = ?", "reviewed_at = ?");
      parameters.push(reviewStatusValue(input.reviewStatus), new Date());
    }
    if (input.reviewedBy !== undefined) {
      assignments.push("reviewed_by = ?");
      parameters.push(input.reviewedBy);
    }
    if (input.reviewNote !== undefined) {
      assignments.push("review_note = ?");
      parameters.push(input.reviewNote);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    parameters.push(new Date(), id, scope.tenantId, input.version);

    let result: ResultSetHeader;
    try {
      [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE company_members
         SET ${assignments.join(", ")}
         WHERE id = ? AND tenant_id = ? AND version = ?`,
        parameters,
      );
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError("This user is already a member of the tenant.");
      }
      throw error;
    }
    if (result.affectedRows === 0) {
      await this.throwUpdateFailure(id, input.version, scope);
    }
    const member = await this.get(id, scope);
    if (!member) throw new NotFoundError("company member", id);
    return member;
  }

  async countActiveApprovedAdmins(
    scope: CompanyMemberScope,
    excludeId?: string,
  ): Promise<number> {
    const predicates = [
      "tenant_id = ?",
      "is_admin = 1",
      "status = 1",
      "review_status = 1",
    ];
    const parameters = [scope.tenantId];
    if (excludeId) {
      predicates.push("id <> ?");
      parameters.push(excludeId);
    }
    const [rows] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total
       FROM company_members
       WHERE ${predicates.join(" AND ")}`,
      parameters,
    );
    return Number(rows[0]?.total ?? 0);
  }

  private async assertUserInTenant(
    userId: string,
    scope: CompanyMemberScope,
  ): Promise<void> {
    const [rows] = await this.pool.execute<UserRow[]>(
      "SELECT id FROM users WHERE id = ? AND tenant_id = ? LIMIT 1",
      [userId, scope.tenantId],
    );
    if (!rows[0]) {
      throw new DomainError(
        "validation_error",
        `userId ${userId} does not belong to tenant ${scope.tenantId}.`,
      );
    }
  }

  private async throwUpdateFailure(
    id: string,
    version: number,
    scope: CompanyMemberScope,
  ): Promise<never> {
    const [rows] = await this.pool.execute<ExistingMemberRow[]>(
      "SELECT id, version FROM company_members WHERE id = ? AND tenant_id = ? LIMIT 1",
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError("company member", id);
    throw new ConflictError(
      `Company member ${id} has changed; expected version ${version}.`,
    );
  }
}
