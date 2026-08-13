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
