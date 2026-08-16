import { z } from "zod";

export const TestBookletStatusSchema = z.enum(["enabled", "disabled"]);

const uniqueGroupIds = z
  .array(z.string().trim().min(1))
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: "Group ids must be unique within a test booklet.",
  });

export const TestBookletItemSchema = z.object({
  groupId: z.string().min(1),
  position: z.number().int().nonnegative(),
  available: z.boolean(),
});

export const TestBookletSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  createdBy: z.string().min(1),
  subjectId: z.string().min(1).nullable(),
  categoryId: z.string().min(1).nullable(),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  status: TestBookletStatusSchema,
  version: z.number().int().positive(),
  items: z.array(TestBookletItemSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deletedAt: z.string().min(1).nullable(),
});

const TestBookletWriteFieldsBaseSchema = z.object({
  subjectId: z.string().trim().min(1).max(191).nullable(),
  categoryId: z.string().trim().min(1).nullable(),
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(200000).nullable(),
  status: TestBookletStatusSchema,
  groupIds: uniqueGroupIds,
});

export const CreateTestBookletSchema = TestBookletWriteFieldsBaseSchema.extend({
  subjectId: TestBookletWriteFieldsBaseSchema.shape.subjectId.default(null),
  categoryId: TestBookletWriteFieldsBaseSchema.shape.categoryId.default(null),
  description: TestBookletWriteFieldsBaseSchema.shape.description.default(null),
  status: TestBookletWriteFieldsBaseSchema.shape.status.default("enabled"),
  groupIds: TestBookletWriteFieldsBaseSchema.shape.groupIds.default([]),
});

export const UpdateTestBookletSchema =
  TestBookletWriteFieldsBaseSchema.partial().extend({
    version: z.number().int().positive(),
  });

export const TestBookletListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  createdBy: z.string().trim().min(1).max(191).optional(),
  status: TestBookletStatusSchema.optional(),
  subjectId: z.string().trim().min(1).max(191).optional(),
  categoryId: z.string().trim().min(1).optional(),
});

export const TestBookletListResponseSchema = z.object({
  items: z.array(TestBookletSchema),
  page: z.object({ nextCursor: z.string().min(1).nullable() }),
});

export const DeleteTestBookletQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
});

export type TestBookletStatus = z.infer<typeof TestBookletStatusSchema>;
export type TestBookletItem = z.infer<typeof TestBookletItemSchema>;
export type TestBooklet = z.infer<typeof TestBookletSchema>;
export type TestBookletListQuery = z.infer<typeof TestBookletListQuerySchema>;
export type CreateTestBookletInput = z.infer<typeof CreateTestBookletSchema>;
export type UpdateTestBookletInput = z.infer<typeof UpdateTestBookletSchema>;
