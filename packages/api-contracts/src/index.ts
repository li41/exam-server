import { z } from "zod";

export const API_VERSION = "v1" as const;
export const API_VERSION_PREFIX = "/api/v1" as const;
export const LEGACY_API_PREFIX = "/api" as const;

export const ItemStatusSchema = z.enum(["draft", "ready"]);

export const ItemSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  title: z.string().min(1).max(200),
  status: ItemStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deletedAt: z.string().min(1).nullable(),
});

export const ItemListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
});

export const CreateItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

export const UpdateItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  version: z.number().int().positive(),
});

export const DeleteItemQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
});

export const PageInfoSchema = z.object({
  nextCursor: z.string().min(1).nullable(),
});

export const ItemListResponseSchema = z.object({
  items: z.array(ItemSchema),
  page: PageInfoSchema,
});

export const QuestionTypeSchema = z.enum([
  "true_false",
  "single_choice",
  "multiple_choice",
  "short_answer",
  "matching",
  "sorting",
  "fill_blank",
  "dropdown",
  "choice_short_answer",
  "math",
  "drawing",
  "development_drawing",
  "interactive",
  "drag_drop",
]);

export const QuestionStatusSchema = z.enum(["enabled", "disabled"]);
export const QuestionMediaRoleSchema = z.enum([
  "stem",
  "option",
  "explanation",
  "attachment",
]);

export const QuestionMediaSchema = z.object({
  fileId: z.string().min(1),
  role: QuestionMediaRoleSchema,
  optionId: z.string().trim().min(1).max(100).nullable().default(null),
  position: z.number().int().nonnegative().default(0),
});

export const QuestionAiRubricEntrySchema = z.object({
  text: z.string().trim().min(1).max(1000),
  score: z.number().nonnegative(),
  keywords: z.array(z.string().trim().min(1).max(100)).default([]),
});

export const QuestionSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  code: z.string().min(1).max(50),
  categoryId: z.string().min(1).nullable(),
  createdBy: z.string().min(1),
  type: QuestionTypeSchema,
  difficulty: z.number().int().min(1).max(5),
  stem: z.string().min(1),
  options: z.json().nullable(),
  answer: z.json(),
  explanation: z.string().nullable(),
  aiRubric: z.array(QuestionAiRubricEntrySchema).nullable(),
  points: z.number().positive().max(9999.9),
  tags: z.array(z.string().trim().min(1).max(100)).max(100),
  status: QuestionStatusSchema,
  usageCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  media: z.array(QuestionMediaSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deletedAt: z.string().min(1).nullable(),
});

const QuestionWriteFieldsSchema = z.object({
  code: z.string().trim().min(1).max(50),
  categoryId: z.string().trim().min(1).nullable().optional(),
  type: QuestionTypeSchema,
  difficulty: z.number().int().min(1).max(5).default(3),
  stem: z.string().trim().min(1).max(200000),
  options: z.json().nullable().default(null),
  answer: z.json(),
  explanation: z.string().max(200000).nullable().default(null),
  aiRubric: z.array(QuestionAiRubricEntrySchema).nullable().default(null),
  points: z.number().positive().max(9999.9).default(1),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  status: QuestionStatusSchema.default("enabled"),
  media: z.array(QuestionMediaSchema).max(200).default([]),
});

export const CreateQuestionSchema = QuestionWriteFieldsSchema;

export const UpdateQuestionSchema = QuestionWriteFieldsSchema.partial().extend({
  version: z.number().int().positive(),
});

export const QuestionListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  createdBy: z.string().trim().min(1).max(191).optional(),
  type: QuestionTypeSchema.optional(),
  categoryId: z.string().trim().min(1).optional(),
  difficulty: z.coerce.number().int().min(1).max(5).optional(),
  status: QuestionStatusSchema.optional(),
});

export const DeleteQuestionQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
});

export const QuestionListResponseSchema = z.object({
  items: z.array(QuestionSchema),
  page: PageInfoSchema,
});

export const QuestionCategorySchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  name: z.string().min(1).max(100),
  sortOrder: z.number().int(),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deletedAt: z.string().min(1).nullable(),
});

export const QuestionCategoryListQuerySchema = z.object({
  parentId: z.string().trim().min(1).optional(),
});

export const CreateQuestionCategorySchema = z.object({
  parentId: z.string().trim().min(1).nullable().default(null),
  name: z.string().trim().min(1).max(100),
  sortOrder: z.number().int().default(0),
});

export const UpdateQuestionCategorySchema = z.object({
  parentId: z.string().trim().min(1).nullable(),
  name: z.string().trim().min(1).max(100),
  sortOrder: z.number().int(),
  version: z.number().int().positive(),
});

export const DeleteQuestionCategoryQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
});

export const FileStatusSchema = z.enum(["pending", "ready", "deleted"]);

export const FileMetadataSchema = z.object({
  fileId: z.string().min(1),
  ownerId: z.string().min(1),
  tenantId: z.string().min(1),
  originalName: z.string().min(1).max(255),
  displayName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string().min(1),
  status: FileStatusSchema,
  createdAt: z.string().min(1),
  deletedAt: z.string().min(1).nullable(),
});

export const AuthIdentitySchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  tenantId: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
});

export const LoginRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

export const AuthTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.string().min(1),
  refreshTokenExpiresAt: z.string().min(1),
});

export const UploadSessionSchema = z.object({
  sessionId: z.string().min(1),
  fileId: z.string().min(1),
  expiresAt: z.string().min(1),
  resumable: z.boolean(),
});

export const InitiateUploadRequestSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const UploadProgressSchema = z.object({
  bytesReceived: z.number().int().nonnegative(),
  complete: z.boolean(),
});

export const ApiErrorCodeSchema = z.enum([
  "validation_error",
  "invalid_cursor",
  "not_found",
  "conflict",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "payload_too_large",
  "checksum_mismatch",
  "upload_expired",
  "capability_missing",
  "internal_error",
]);

export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
  }),
  requestId: z.string().min(1),
});

export type Item = z.infer<typeof ItemSchema>;
export type ItemListQuery = z.infer<typeof ItemListQuerySchema>;
export type CreateItemInput = z.infer<typeof CreateItemSchema>;
export type UpdateItemInput = z.infer<typeof UpdateItemSchema>;
export type DeleteItemQuery = z.infer<typeof DeleteItemQuerySchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type QuestionType = z.infer<typeof QuestionTypeSchema>;
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;
export type QuestionMedia = z.infer<typeof QuestionMediaSchema>;
export type QuestionListQuery = z.infer<typeof QuestionListQuerySchema>;
export type CreateQuestionInput = z.infer<typeof CreateQuestionSchema>;
export type UpdateQuestionInput = z.infer<typeof UpdateQuestionSchema>;
export type QuestionCategory = z.infer<typeof QuestionCategorySchema>;
export type QuestionCategoryListQuery = z.infer<
  typeof QuestionCategoryListQuerySchema
>;
export type CreateQuestionCategoryInput = z.infer<
  typeof CreateQuestionCategorySchema
>;
export type UpdateQuestionCategoryInput = z.infer<
  typeof UpdateQuestionCategorySchema
>;
export type Page<T> = {
  items: T[];
  page: z.infer<typeof PageInfoSchema>;
};
export type FileMetadata = z.infer<typeof FileMetadataSchema>;
export type UploadSession = z.infer<typeof UploadSessionSchema>;
export type InitiateUploadRequest = z.infer<typeof InitiateUploadRequestSchema>;
export type UploadProgress = z.infer<typeof UploadProgressSchema>;
export type AuthIdentity = z.infer<typeof AuthIdentitySchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;
