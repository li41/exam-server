import { z } from "zod";

export const COMPANY_MEMBER_PERMISSION_KEYS = [
  "questions_all",
  "questions_own",
  "media",
  "exams",
  "examinees",
  "results",
  "reports",
  "settings",
  "members",
  "categories",
  "logs",
  "exam_affairs",
  "site",
] as const;

export const CompanyMemberPermissionSchema = z.enum(
  COMPANY_MEMBER_PERMISSION_KEYS,
);
export type CompanyMemberPermission = z.infer<
  typeof CompanyMemberPermissionSchema
>;

const CompanyMemberPermissionsShape = {
  questions_all: z.boolean(),
  questions_own: z.boolean(),
  media: z.boolean(),
  exams: z.boolean(),
  examinees: z.boolean(),
  results: z.boolean(),
  reports: z.boolean(),
  settings: z.boolean(),
  members: z.boolean(),
  categories: z.boolean(),
  logs: z.boolean(),
  exam_affairs: z.boolean(),
  site: z.boolean(),
} satisfies Record<CompanyMemberPermission, ReturnType<typeof z.boolean>>;

export const CompanyMemberPermissionsSchema = z.strictObject(
  CompanyMemberPermissionsShape,
);
export type CompanyMemberPermissions = z.infer<
  typeof CompanyMemberPermissionsSchema
>;

export const COMPANY_MEMBER_NO_PERMISSIONS = {
  questions_all: false,
  questions_own: false,
  media: false,
  exams: false,
  examinees: false,
  results: false,
  reports: false,
  settings: false,
  members: false,
  categories: false,
  logs: false,
  exam_affairs: false,
  site: false,
} satisfies CompanyMemberPermissions;

export const COMPANY_MEMBER_ADMIN_PERMISSIONS = {
  questions_all: true,
  questions_own: false,
  media: true,
  exams: true,
  examinees: true,
  results: true,
  reports: true,
  settings: true,
  members: true,
  categories: true,
  logs: true,
  exam_affairs: true,
  site: true,
} satisfies CompanyMemberPermissions;

export const CompanyMemberStatusSchema = z.enum(["disabled", "active"]);
export const CompanyMemberReviewStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);

export const CompanyMemberSchema = z.strictObject({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  invitedEmail: z.string().email().max(254).nullable(),
  isAdmin: z.boolean(),
  permissions: CompanyMemberPermissionsSchema,
  status: CompanyMemberStatusSchema,
  reviewStatus: CompanyMemberReviewStatusSchema,
  reviewedBy: z.string().min(1).nullable(),
  reviewedAt: z.string().min(1).nullable(),
  reviewNote: z.string().max(500).nullable(),
  joinedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  version: z.number().int().positive(),
});

export const CreateCompanyMemberSchema = z.strictObject({
  userId: z.string().trim().min(1).max(191),
  invitedEmail: z.string().trim().email().max(254).nullable().default(null),
  isAdmin: z.boolean().default(false),
  permissions: CompanyMemberPermissionsSchema.default(
    COMPANY_MEMBER_NO_PERMISSIONS,
  ),
  status: CompanyMemberStatusSchema.default("active"),
  reviewStatus: CompanyMemberReviewStatusSchema.default("approved"),
  reviewedBy: z.string().trim().min(1).max(191).nullable().default(null),
  reviewNote: z.string().trim().max(500).nullable().default(null),
});

const CompanyMemberWriteFieldsBaseSchema = z.strictObject({
  userId: z.string().trim().min(1).max(191),
  invitedEmail: z.string().trim().email().max(254).nullable(),
  isAdmin: z.boolean(),
  permissions: CompanyMemberPermissionsSchema,
  status: CompanyMemberStatusSchema,
  reviewStatus: CompanyMemberReviewStatusSchema,
  reviewedBy: z.string().trim().min(1).max(191).nullable(),
  reviewNote: z.string().trim().max(500).nullable(),
});

export const UpdateCompanyMemberSchema =
  CompanyMemberWriteFieldsBaseSchema.partial().extend({
    version: z.number().int().positive(),
  });

export const CompanyMemberListQuerySchema = z.strictObject({
  status: CompanyMemberStatusSchema.optional(),
  reviewStatus: CompanyMemberReviewStatusSchema.optional(),
  search: z.string().trim().max(100).optional(),
});

export const CompanyMemberListResponseSchema = z.array(CompanyMemberSchema);

export type CompanyMemberStatus = z.infer<typeof CompanyMemberStatusSchema>;
export type CompanyMemberReviewStatus = z.infer<
  typeof CompanyMemberReviewStatusSchema
>;
export type CompanyMember = z.infer<typeof CompanyMemberSchema>;
export type CreateCompanyMemberInput = z.infer<
  typeof CreateCompanyMemberSchema
>;
export type UpdateCompanyMemberInput = z.infer<
  typeof UpdateCompanyMemberSchema
>;
export type CompanyMemberListQuery = z.infer<
  typeof CompanyMemberListQuerySchema
>;
