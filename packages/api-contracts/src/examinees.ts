import { z } from "zod";

export const ExamineeStatusSchema = z.enum(["enabled", "disabled"]);

export const ExamineeGroupSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  name: z.string().min(1).max(100),
  proctorPassword: z.string().min(4).max(50).nullable(),
  sortOrder: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deletedAt: z.string().min(1).nullable(),
});

const ProctorPasswordSchema = z.string().trim().min(4).max(50).nullable();

export const CreateExamineeGroupSchema = z.object({
  parentId: z.string().trim().min(1).nullable().default(null),
  name: z.string().trim().min(1).max(100),
  proctorPassword: ProctorPasswordSchema.default(null),
  sortOrder: z.number().int().nonnegative().default(0),
});

export const UpdateExamineeGroupSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  proctorPassword: ProctorPasswordSchema.optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  version: z.number().int().positive(),
});

export const ExamineeGroupListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
});

export const DeleteExamineeGroupQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
});

export const ExamineeSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  groupId: z.string().min(1).nullable(),
  createdBy: z.string().min(1),
  code: z.string().min(1).max(50),
  identifier: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  note: z.string().nullable(),
  status: ExamineeStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deletedAt: z.string().min(1).nullable(),
});

const ExamineeWriteFieldsBaseSchema = z.object({
  groupId: z.string().trim().min(1).nullable(),
  code: z.string().trim().min(1).max(50),
  identifier: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  note: z.string().max(200000).nullable(),
  status: ExamineeStatusSchema,
});

export const CreateExamineeSchema = ExamineeWriteFieldsBaseSchema.extend({
  groupId: ExamineeWriteFieldsBaseSchema.shape.groupId.default(null),
  note: ExamineeWriteFieldsBaseSchema.shape.note.default(null),
  status: ExamineeWriteFieldsBaseSchema.shape.status.default("enabled"),
});

export const UpdateExamineeSchema = ExamineeWriteFieldsBaseSchema.partial().extend({
  version: z.number().int().positive(),
});

export const ExamineeListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  createdBy: z.string().trim().min(1).max(191).optional(),
  status: ExamineeStatusSchema.optional(),
  groupId: z.string().trim().min(1).optional(),
});

export const ExamineeListResponseSchema = z.object({
  items: z.array(ExamineeSchema),
  page: z.object({ nextCursor: z.string().min(1).nullable() }),
});

export const DeleteExamineeQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
});

export type ExamineeStatus = z.infer<typeof ExamineeStatusSchema>;
export type ExamineeGroup = z.infer<typeof ExamineeGroupSchema>;
export type CreateExamineeGroupInput = z.infer<
  typeof CreateExamineeGroupSchema
>;
export type UpdateExamineeGroupInput = z.infer<
  typeof UpdateExamineeGroupSchema
>;
export type ExamineeGroupListQuery = z.infer<
  typeof ExamineeGroupListQuerySchema
>;
export type Examinee = z.infer<typeof ExamineeSchema>;
export type CreateExamineeInput = z.infer<typeof CreateExamineeSchema>;
export type UpdateExamineeInput = z.infer<typeof UpdateExamineeSchema>;
export type ExamineeListQuery = z.infer<typeof ExamineeListQuerySchema>;
