import {
  COMPANY_MEMBER_NO_PERMISSIONS,
  ConflictError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  CompanyMember,
  CompanyMemberListQuery,
  CompanyMemberRepository,
  CompanyMemberScope,
  CreateCompanyMemberInput,
  UpdateCompanyMemberInput,
} from "@server-foundation/domain";

export const companyMemberFixture = (
  overrides: Partial<CompanyMember> = {},
): CompanyMember => ({
  id: "member-fixture",
  tenantId: "local-development-tenant",
  userId: "local-development-user",
  invitedEmail: null,
  isAdmin: false,
  permissions: { ...COMPANY_MEMBER_NO_PERMISSIONS },
  status: "active",
  reviewStatus: "approved",
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  joinedAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  version: 1,
  ...overrides,
});

export class InMemoryCompanyMemberRepository implements CompanyMemberRepository {
  private readonly members: CompanyMember[];
  private nextId = 1;

  constructor(initialMembers: CompanyMember[] = []) {
    this.members = structuredClone(initialMembers);
  }

  list(
    query: CompanyMemberListQuery,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember[]> {
    const search = query.search?.toLocaleLowerCase();
    const members = this.members
      .filter((member) => {
        if (member.tenantId !== scope.tenantId) return false;
        if (query.status && member.status !== query.status) return false;
        if (query.reviewStatus && member.reviewStatus !== query.reviewStatus) {
          return false;
        }
        if (!search) return true;
        return [member.userId, member.invitedEmail ?? ""].some((value) =>
          value.toLocaleLowerCase().includes(search),
        );
      })
      .sort(
        (left, right) =>
          Number(right.isAdmin) - Number(left.isAdmin) ||
          reviewOrder(left.reviewStatus) - reviewOrder(right.reviewStatus) ||
          statusOrder(right.status) - statusOrder(left.status) ||
          left.joinedAt.localeCompare(right.joinedAt) ||
          left.id.localeCompare(right.id),
      );
    return Promise.resolve(structuredClone(members));
  }

  get(id: string, scope: CompanyMemberScope): Promise<CompanyMember | null> {
    const member = this.members.find(
      (candidate) =>
        candidate.id === id && candidate.tenantId === scope.tenantId,
    );
    return Promise.resolve(member ? structuredClone(member) : null);
  }

  findByUserId(
    userId: string,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember | null> {
    const member = this.members.find(
      (candidate) =>
        candidate.userId === userId && candidate.tenantId === scope.tenantId,
    );
    return Promise.resolve(member ? structuredClone(member) : null);
  }

  async create(
    input: CreateCompanyMemberInput,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember> {
    this.assertUniqueUser(input.userId, scope);
    const now = new Date().toISOString();
    const member: CompanyMember = {
      id: `company-member-${this.nextId++}`,
      tenantId: scope.tenantId,
      ...input,
      reviewedAt: input.reviewedBy ? now : null,
      joinedAt: now,
      updatedAt: now,
      version: 1,
    };
    this.members.push(member);
    return structuredClone(member);
  }

  async update(
    id: string,
    input: UpdateCompanyMemberInput,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember> {
    const member = this.requiredMember(id, scope);
    if (member.version !== input.version) {
      throw new ConflictError(
        `Company member ${id} has changed; expected version ${input.version}.`,
      );
    }
    if (input.userId !== undefined && input.userId !== member.userId) {
      this.assertUniqueUser(input.userId, scope, id);
      member.userId = input.userId;
    }
    if (input.invitedEmail !== undefined)
      member.invitedEmail = input.invitedEmail;
    if (input.isAdmin !== undefined) member.isAdmin = input.isAdmin;
    if (input.permissions !== undefined)
      member.permissions = structuredClone(input.permissions);
    if (input.status !== undefined) member.status = input.status;
    if (input.reviewStatus !== undefined) {
      member.reviewStatus = input.reviewStatus;
      member.reviewedAt = new Date().toISOString();
    }
    if (input.reviewedBy !== undefined) member.reviewedBy = input.reviewedBy;
    if (input.reviewNote !== undefined) member.reviewNote = input.reviewNote;
    member.version += 1;
    member.updatedAt = new Date().toISOString();
    return structuredClone(member);
  }

  countActiveApprovedAdmins(
    scope: CompanyMemberScope,
    excludeId?: string,
  ): Promise<number> {
    return Promise.resolve(
      this.members.filter(
        (member) =>
          member.tenantId === scope.tenantId &&
          member.id !== excludeId &&
          member.isAdmin &&
          member.status === "active" &&
          member.reviewStatus === "approved",
      ).length,
    );
  }

  private requiredMember(id: string, scope: CompanyMemberScope): CompanyMember {
    const member = this.members.find(
      (candidate) =>
        candidate.id === id && candidate.tenantId === scope.tenantId,
    );
    if (!member) throw new NotFoundError("company member", id);
    return member;
  }

  private assertUniqueUser(
    userId: string,
    scope: CompanyMemberScope,
    excludeId?: string,
  ): void {
    if (
      this.members.some(
        (member) =>
          member.tenantId === scope.tenantId &&
          member.userId === userId &&
          member.id !== excludeId,
      )
    ) {
      throw new ConflictError("This user is already a member of the tenant.");
    }
  }
}

const reviewOrder = (value: CompanyMember["reviewStatus"]): number => {
  if (value === "pending") return 0;
  if (value === "approved") return 1;
  return 2;
};

const statusOrder = (value: CompanyMember["status"]): number =>
  value === "active" ? 1 : 0;

export const createInMemoryCompanyMemberRepository = (
  initialMembers: CompanyMember[] = [],
): InMemoryCompanyMemberRepository =>
  new InMemoryCompanyMemberRepository(initialMembers);
