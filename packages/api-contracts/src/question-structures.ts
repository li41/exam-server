import { z } from "zod";

export const QuestionCollectionStatusSchema = z.enum(["enabled", "disabled"]);
export const QuestionGroupFlowModeSchema = z.enum([
  "normal",
  "shuffle",
  "skip",
]);

const uniqueQuestionIds = z
  .array(z.string().trim().min(1))
  .max(500)
  .refine((values) => new Set(values).size === values.length, {
    message: "Question ids must be unique within a cluster.",
  });

export const QuestionClusterItemSchema = z.object({
  questionId: z.string().min(1),
  position: z.number().int().nonnegative(),
  available: z.boolean(),
});

export const QuestionClusterSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  createdBy: z.string().min(1),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  stem: z.string().min(1),
  stemFileId: z.string().min(1).nullable(),
  description: z.string().nullable(),
  status: QuestionCollectionStatusSchema,
  usageCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  items: z.array(QuestionClusterItemSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deletedAt: z.string().min(1).nullable(),
});

const QuestionClusterWriteFieldsBaseSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  stem: z.string().trim().min(1).max(200000),
  stemFileId: z.string().trim().min(1).nullable(),
  description: z.string().max(200000).nullable(),
  status: QuestionCollectionStatusSchema,
  questionIds: uniqueQuestionIds,
});

export const CreateQuestionClusterSchema =
  QuestionClusterWriteFieldsBaseSchema.extend({
    stemFileId:
      QuestionClusterWriteFieldsBaseSchema.shape.stemFileId.default(null),
    description:
      QuestionClusterWriteFieldsBaseSchema.shape.description.default(null),
    status:
      QuestionClusterWriteFieldsBaseSchema.shape.status.default("enabled"),
    questionIds:
      QuestionClusterWriteFieldsBaseSchema.shape.questionIds.default([]),
  });

export const UpdateQuestionClusterSchema =
  QuestionClusterWriteFieldsBaseSchema.partial().extend({
    version: z.number().int().positive(),
  });

export const QuestionClusterListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  createdBy: z.string().trim().min(1).max(191).optional(),
  status: QuestionCollectionStatusSchema.optional(),
});

export const QuestionClusterListResponseSchema = z.object({
  items: z.array(QuestionClusterSchema),
  page: z.object({ nextCursor: z.string().min(1).nullable() }),
});

export const QuestionGroupQuestionItemInputSchema = z.object({
  itemType: z.literal("question"),
  questionId: z.string().trim().min(1),
});

export const QuestionGroupClusterItemInputSchema = z.object({
  itemType: z.literal("cluster"),
  clusterId: z.string().trim().min(1),
});

export const QuestionGroupItemInputSchema = z.discriminatedUnion("itemType", [
  QuestionGroupQuestionItemInputSchema,
  QuestionGroupClusterItemInputSchema,
]);

const uniqueGroupItems = z
  .array(QuestionGroupItemInputSchema)
  .max(1000)
  .refine(
    (items) => {
      const keys = items.map((item) =>
        item.itemType === "question"
          ? `question:${item.questionId}`
          : `cluster:${item.clusterId}`,
      );
      return new Set(keys).size === keys.length;
    },
    { message: "Group items must be unique." },
  );

export const QuestionGroupQuestionItemSchema =
  QuestionGroupQuestionItemInputSchema.extend({
    position: z.number().int().nonnegative(),
    available: z.boolean(),
  });

export const QuestionGroupClusterItemSchema =
  QuestionGroupClusterItemInputSchema.extend({
    position: z.number().int().nonnegative(),
    available: z.boolean(),
  });

export const QuestionGroupItemSchema = z.discriminatedUnion("itemType", [
  QuestionGroupQuestionItemSchema,
  QuestionGroupClusterItemSchema,
]);

export const QuestionGroupSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  createdBy: z.string().min(1),
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  subjectId: z.string().min(1).nullable(),
  flowMode: QuestionGroupFlowModeSchema,
  status: QuestionCollectionStatusSchema,
  usageCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  items: z.array(QuestionGroupItemSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deletedAt: z.string().min(1).nullable(),
});

const QuestionGroupWriteFieldsBaseSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(200000).nullable(),
  subjectId: z.string().trim().min(1).nullable(),
  flowMode: QuestionGroupFlowModeSchema,
  status: QuestionCollectionStatusSchema,
  items: uniqueGroupItems,
});

export const CreateQuestionGroupSchema = QuestionGroupWriteFieldsBaseSchema.extend(
  {
    description:
      QuestionGroupWriteFieldsBaseSchema.shape.description.default(null),
    subjectId: QuestionGroupWriteFieldsBaseSchema.shape.subjectId.default(null),
    flowMode: QuestionGroupWriteFieldsBaseSchema.shape.flowMode.default("normal"),
    status: QuestionGroupWriteFieldsBaseSchema.shape.status.default("enabled"),
    items: QuestionGroupWriteFieldsBaseSchema.shape.items.default([]),
  },
);

export const UpdateQuestionGroupSchema =
  QuestionGroupWriteFieldsBaseSchema.partial().extend({
    version: z.number().int().positive(),
  });

export const QuestionGroupListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  createdBy: z.string().trim().min(1).max(191).optional(),
  status: QuestionCollectionStatusSchema.optional(),
  subjectId: z.string().trim().min(1).optional(),
  flowMode: QuestionGroupFlowModeSchema.optional(),
});

export const QuestionGroupListResponseSchema = z.object({
  items: z.array(QuestionGroupSchema),
  page: z.object({ nextCursor: z.string().min(1).nullable() }),
});

export const DeleteQuestionStructureQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
});

export type QuestionCollectionStatus = z.infer<
  typeof QuestionCollectionStatusSchema
>;
export type QuestionGroupFlowMode = z.infer<typeof QuestionGroupFlowModeSchema>;
export type QuestionClusterItem = z.infer<typeof QuestionClusterItemSchema>;
export type QuestionCluster = z.infer<typeof QuestionClusterSchema>;
export type QuestionClusterListQuery = z.infer<
  typeof QuestionClusterListQuerySchema
>;
export type CreateQuestionClusterInput = z.infer<
  typeof CreateQuestionClusterSchema
>;
export type UpdateQuestionClusterInput = z.infer<
  typeof UpdateQuestionClusterSchema
>;
export type QuestionGroupItemInput = z.infer<
  typeof QuestionGroupItemInputSchema
>;
export type QuestionGroupItem = z.infer<typeof QuestionGroupItemSchema>;
export type QuestionGroup = z.infer<typeof QuestionGroupSchema>;
export type QuestionGroupListQuery = z.infer<typeof QuestionGroupListQuerySchema>;
export type CreateQuestionGroupInput = z.infer<typeof CreateQuestionGroupSchema>;
export type UpdateQuestionGroupInput = z.infer<typeof UpdateQuestionGroupSchema>;
