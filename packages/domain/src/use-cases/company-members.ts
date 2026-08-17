import {
  COMPANY_MEMBER_ADMIN_PERMISSIONS,
  COMPANY_MEMBER_NO_PERMISSIONS,
  COMPANY_MEMBER_PERMISSION_KEYS,
} from "../ports/company-member-repository.js";
import type {
  CompanyMember,
  CompanyMemberListQuery,
  CompanyMemberPermission,
  CompanyMemberPermissions,
  CompanyMemberRepository,
  CompanyMemberReviewStatus,
  CompanyMemberScope,
  CompanyMemberStatus,
  CreateCompanyMemberInput,
  UpdateCompanyMemberInput,
} from "../ports/company-member-repository.js";
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from "../errors.js";

const permissionKeySet = new Set<string>(COMPANY_MEMBER_PERMISSION_KEYS);
const statusValues = new Set<CompanyMemberStatus>(["disabled", "active"]);
const reviewStatusValues = new Set<CompanyMemberReviewStatus>([
  "pending",
  "approved",
  "rejected",
]);

const validationError = (message: string): never => {
  throw new DomainError("validation_error", message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) validationError(`${label} contains unknown key "${key}".`);
  }
};

const parseRequiredString = (
  value: unknown,
  field: string,
  maxLength: number,
): string => {
  if (typeof value !== "string") {
    throw new DomainError("validation_error", `${field} must be a string.`);
  }
  const parsed = value.trim();
  if (!parsed || parsed.length > maxLength) {
    validationError(`${field} must be between 1 and ${maxLength} characters.`);
  }
  return parsed;
};

const parseNullableString = (
  value: unknown,
  field: string,
  maxLength: number,
): string | null => {
  if (value === null) return null;
  return parseRequiredString(value, field, maxLength);
};

const parseNullableEmail = (value: unknown): string | null => {
  if (value === null) return null;
  const email = parseRequiredString(value, "invitedEmail", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    validationError("invitedEmail must be a valid email address.");
  }
  return email;
};

const parseBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new DomainError("validation_error", `${field} must be boolean.`);
  }
  return value;
};

const parsePositiveInteger = (value: unknown, field: string): number => {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    validationError(`${field} must be a positive integer.`);
  }
  return Number(value);
};

const parseStatus = (value: unknown): CompanyMemberStatus => {
  if (typeof value !== "string" || !statusValues.has(value as CompanyMemberStatus)) {
    validationError('status must be either "active" or "disabled".');
  }
  return value as CompanyMemberStatus;
};

const parseReviewStatus = (value: unknown): CompanyMemberReviewStatus => {
  if (
    typeof value !== "string" ||
    !reviewStatusValues.has(value as CompanyMemberReviewStatus)
  ) {
    validationError(
      'reviewStatus must be "pending", "approved", or "rejected".',
    );
  }
  return value as CompanyMemberReviewStatus;
};

export const parseCompanyMemberPermissions = (
  value: unknown,
): CompanyMemberPermissions => {
  if (!isRecord(value)) validationError("permissions must be an object.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const missing = COMPANY_MEMBER_PERMISSION_KEYS.filter((key) => !(key in record));
  const extras = keys.filter((key) => !permissionKeySet.has(key));
  if (missing.length > 0 || extras.length > 0) {
    const details = [
      missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
      extras.length > 0 ? `unknown: ${extras.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    validationError(`permissions must contain exactly the 13 PHP keys (${details}).`);
  }

  const parsed = {} as CompanyMemberPermissions;
  for (const key of COMPANY_MEMBER_PERMISSION_KEYS) {
    parsed[key] = parseBoolean(record[key], `permissions.${key}`);
  }
  return parsed;
};

export const normalizeCompanyMemberPermissions = (
  permissions: CompanyMemberPermissions,
): CompanyMemberPermissions => {
  const normalized = { ...permissions };
  if (normalized.questions_all && normalized.questions_own) {
    normalized.questions_own = false;
  }
  return normalized;
};

export const hasCompanyMemberPermission = (
  member: CompanyMember,
  permission: CompanyMemberPermission,
): boolean => {
  if (member.isAdmin) return true;
  if (member.reviewStatus !== "approved") return false;
  return member.permissions[permission];
};

export const canUseCompanyMemberPermission = (
  member: CompanyMember,
  permission: CompanyMemberPermission,
): boolean =>
  member.status === "active" && hasCompanyMemberPermission(member, permission);

const createKeys = new Set([
  "userId",
  "invitedEmail",
  "isAdmin",
  "permissions",
  "status",
  "reviewStatus",
  "reviewedBy",
  "reviewNote",
]);

const updateKeys = new Set([...createKeys, "version"]);
const listKeys = new Set(["status", "reviewStatus", "search"]);

export const parseCreateCompanyMemberInput = (
  value: unknown,
): CreateCompanyMemberInput => {
  if (!isRecord(value)) validationError("Company member payload must be an object.");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, createKeys, "Company member payload");
  return {
    userId: parseRequiredString(record.userId, "userId", 191),
    invitedEmail:
      record.invitedEmail === undefined ? null : parseNullableEmail(record.invitedEmail),
    isAdmin: record.isAdmin === undefined ? false : parseBoolean(record.isAdmin, "isAdmin"),
    permissions:
      record.permissions === undefined
        ? { ...COMPANY_MEMBER_NO_PERMISSIONS }
        : parseCompanyMemberPermissions(record.permissions),
    status: record.status === undefined ? "active" : parseStatus(record.status),
    reviewStatus:
      record.reviewStatus === undefined
        ? "approved"
        : parseReviewStatus(record.reviewStatus),
    reviewedBy:
      record.reviewedBy === undefined
        ? null
        : parseNullableString(record.reviewedBy, "reviewedBy", 191),
    reviewNote:
      record.reviewNote === undefined
        ? null
        : parseNullableString(record.reviewNote, "reviewNote", 500),
  };
};

export const parseUpdateCompanyMemberInput = (
  value: unknown,
): UpdateCompanyMemberInput => {
  if (!isRecord(value)) validationError("Company member payload must be an object.");
  const record = value as Record<string, unknown>;
  assertExactKeys(record, updateKeys, "Company member payload");
  const version = parsePositiveInteger(record.version, "version");
  const input: UpdateCompanyMemberInput = { version };
  if (record.userId !== undefined) {
    input.userId = parseRequiredString(record.userId, "userId", 191);
  }
  if (record.invitedEmail !== undefined) {
    input.invitedEmail = parseNullableEmail(record.invitedEmail);
  }
  if (record.isAdmin !== undefined) input.isAdmin = parseBoolean(record.isAdmin, "isAdmin");
  if (record.permissions !== undefined) {
    input.permissions = parseCompanyMemberPermissions(record.permissions);
  }
  if (record.status !== undefined) input.status = parseStatus(record.status);
  if (record.reviewStatus !== undefined) {
    input.reviewStatus = parseReviewStatus(record.reviewStatus);
  }
  if (record.reviewedBy !== undefined) {
    input.reviewedBy = parseNullableString(record.reviewedBy, "reviewedBy", 191);
  }
  if (record.reviewNote !== undefined) {
    input.reviewNote = parseNullableString(record.reviewNote, "reviewNote", 500);
  }
  if (Object.keys(input).length === 1) {
    validationError("Company member update must change at least one field.");
  }
  return input;
};

export const parseCompanyMemberListQuery = (
  value: Record<string, string>,
): CompanyMemberListQuery => {
  assertExactKeys(value, listKeys, "Company member query");
  const query: CompanyMemberListQuery = {};
  if (value.status !== undefined) query.status = parseStatus(value.status);
  if (value.reviewStatus !== undefined) {
    query.reviewStatus = parseReviewStatus(value.reviewStatus);
  }
  if (value.search !== undefined) {
    const search = value.search.trim();
    if (search.length > 100) validationError("search must not exceed 100 characters.");
    if (search) query.search = search;
  }
  return query;
};

export class CompanyMemberService {
  constructor(private readonly repository: CompanyMemberRepository) {}

  async list(
    query: CompanyMemberListQuery,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember[]> {
    await this.requireManager(scope);
    return this.repository.list(query, scope);
  }

  async get(id: string, scope: CompanyMemberScope): Promise<CompanyMember> {
    await this.requireManager(scope);
    return this.requiredMember(id, scope);
  }

  async create(
    input: CreateCompanyMemberInput,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember> {
    const actor = await this.requireManager(scope);
    if (input.isAdmin && !actor.isAdmin) {
      throw new ForbiddenError("Only an administrator can create another administrator.");
    }
    return this.repository.create(
      {
        ...input,
        permissions: input.isAdmin
          ? { ...COMPANY_MEMBER_ADMIN_PERMISSIONS }
          : normalizeCompanyMemberPermissions(input.permissions),
      },
      scope,
    );
  }

  async update(
    id: string,
    input: UpdateCompanyMemberInput,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember> {
    const actor = await this.requireManager(scope);
    const current = await this.requiredMember(id, scope);
    if (current.userId === scope.actorUserId) {
      throw new ForbiddenError("You cannot edit your own membership.");
    }

    const nextIsAdmin = input.isAdmin ?? current.isAdmin;
    if (!actor.isAdmin && (current.isAdmin || nextIsAdmin)) {
      throw new ForbiddenError("Only an administrator can modify administrators.");
    }

    if (current.isAdmin && input.isAdmin === false) {
      if (!input.permissions) {
        validationError(
          "permissions are required when demoting an administrator to a member.",
        );
      }
      const remainingAdmins = await this.repository.countActiveApprovedAdmins(
        scope,
        current.id,
      );
      if (remainingAdmins < 1) {
        throw new ConflictError("A tenant must keep at least one active approved administrator.");
      }
    }

    const normalizedInput: UpdateCompanyMemberInput = { ...input };
    if (input.reviewStatus !== undefined && input.reviewedBy === undefined) {
      normalizedInput.reviewedBy = scope.actorUserId;
    }
    if (nextIsAdmin) {
      normalizedInput.permissions = { ...COMPANY_MEMBER_ADMIN_PERMISSIONS };
    } else if (input.permissions) {
      normalizedInput.permissions = normalizeCompanyMemberPermissions(
        input.permissions,
      );
    }

    return this.repository.update(id, normalizedInput, scope);
  }

  private async requireManager(scope: CompanyMemberScope): Promise<CompanyMember> {
    const actor = await this.repository.findByUserId(scope.actorUserId, scope);
    if (!actor || !canUseCompanyMemberPermission(actor, "members")) {
      throw new ForbiddenError();
    }
    return actor;
  }

  private async requiredMember(
    id: string,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember> {
    const member = await this.repository.get(id, scope);
    if (!member) throw new NotFoundError("company member", id);
    return member;
  }
}
