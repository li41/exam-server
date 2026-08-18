import {
  COMPANY_MEMBER_ADMIN_PERMISSIONS,
  COMPANY_MEMBER_NO_PERMISSIONS,
  COMPANY_MEMBER_PERMISSION_KEYS,
} from "@server-foundation/api-contracts";
import type {
  CompanyMember,
  CompanyMemberListQuery,
  CompanyMemberPermission,
  CompanyMemberPermissions,
  CompanyMemberReviewStatus,
  CompanyMemberStatus,
  CreateCompanyMemberInput,
  UpdateCompanyMemberInput,
} from "@server-foundation/api-contracts";

export {
  COMPANY_MEMBER_ADMIN_PERMISSIONS,
  COMPANY_MEMBER_NO_PERMISSIONS,
  COMPANY_MEMBER_PERMISSION_KEYS,
};
export type {
  CompanyMember,
  CompanyMemberListQuery,
  CompanyMemberPermission,
  CompanyMemberPermissions,
  CompanyMemberReviewStatus,
  CompanyMemberStatus,
  CreateCompanyMemberInput,
  UpdateCompanyMemberInput,
};

export type CompanyMemberScope = {
  tenantId: string;
  actorUserId: string;
};

export interface CompanyMemberRepository {
  list(
    query: CompanyMemberListQuery,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember[]>;
  get(id: string, scope: CompanyMemberScope): Promise<CompanyMember | null>;
  findByUserId(
    userId: string,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember | null>;
  create(
    input: CreateCompanyMemberInput,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember>;
  update(
    id: string,
    input: UpdateCompanyMemberInput,
    scope: CompanyMemberScope,
  ): Promise<CompanyMember>;
  countActiveApprovedAdmins(
    scope: CompanyMemberScope,
    excludeId?: string,
  ): Promise<number>;
}
