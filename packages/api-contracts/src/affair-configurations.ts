import { z } from "zod";
import { AffairStatusSchema } from "./affairs.js";

export const AffairCollectionTypeSchema = z.enum(["form", "excel", "receipt"]);
export const AffairCollectionTargetSchema = z.enum(["school", "city"]);
export const AffairExcelFieldDataTypeSchema = z.enum([
  "text",
  "number",
  "date",
  "time",
  "select",
]);

/**
 * PHP currently stores only the form layout in collection.settings.
 * Keep this strict so new JSON keys cannot silently become an undeclared contract.
 */
export const AffairCollectionSettingsSchema = z
  .object({
    layout: z.string().max(200000).optional(),
  })
  .strict();

/**
 * Exact keys emitted by AffairFieldAjaxActions::parseFieldValidation().
 * The PHP model's defaultValidation() omits the date/time keys, but the write path
 * does emit them, so the write path is the truth source here.
 */
export const AffairExcelFieldValidationSchema = z
  .object({
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    min_length: z.number().int().nonnegative().nullable().optional(),
    max_length: z.number().int().nonnegative().nullable().optional(),
    min_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    max_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    min_time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    max_time: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    pattern: z.string().max(2000).nullable().optional(),
    pattern_desc: z.string().max(500).nullable().optional(),
  })
  .strict();

export const AffairSelectOptionsSchema = z
  .array(z.string().trim().min(1).max(500))
  .max(500);

export const AffairCollectionSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  affairId: z.string().min(1),
  name: z.string().min(1).max(200),
  type: AffairCollectionTypeSchema,
  target: AffairCollectionTargetSchema,
  sortOrder: z.number().int(),
  status: AffairStatusSchema,
  settings: AffairCollectionSettingsSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const AffairCollectionListQuerySchema = z
  .object({
    affairId: z.string().trim().min(1),
    type: AffairCollectionTypeSchema.optional(),
    target: AffairCollectionTargetSchema.optional(),
    status: AffairStatusSchema.optional(),
  })
  .strict();

export const CreateAffairCollectionSchema = z
  .object({
    affairId: z.string().trim().min(1),
    name: z.string().trim().min(1).max(200),
    type: AffairCollectionTypeSchema,
    target: AffairCollectionTargetSchema.default("school"),
    status: AffairStatusSchema.default("enabled"),
  })
  .strict();

export const UpdateAffairCollectionSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    target: AffairCollectionTargetSchema.optional(),
    status: AffairStatusSchema.optional(),
    sortOrder: z.number().int().nonnegative().optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const AffairExcelFieldSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable(),
  dataType: AffairExcelFieldDataTypeSchema,
  isRequired: z.boolean(),
  validation: AffairExcelFieldValidationSchema.nullable(),
  selectOptions: AffairSelectOptionsSchema.nullable(),
  sortOrder: z.number().int(),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const AffairExcelFieldWriteBaseSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).nullable(),
    dataType: AffairExcelFieldDataTypeSchema,
    isRequired: z.boolean(),
    validation: AffairExcelFieldValidationSchema.nullable(),
    selectOptions: AffairSelectOptionsSchema.nullable(),
    sortOrder: z.number().int().nonnegative(),
  })
  .strict();

export const CreateAffairExcelFieldSchema =
  AffairExcelFieldWriteBaseSchema.extend({
    description:
      AffairExcelFieldWriteBaseSchema.shape.description.default(null),
    dataType: AffairExcelFieldWriteBaseSchema.shape.dataType.default("text"),
    isRequired: AffairExcelFieldWriteBaseSchema.shape.isRequired.default(false),
    validation: AffairExcelFieldWriteBaseSchema.shape.validation.default(null),
    selectOptions:
      AffairExcelFieldWriteBaseSchema.shape.selectOptions.default(null),
    sortOrder: AffairExcelFieldWriteBaseSchema.shape.sortOrder.default(0),
  })
    .strict()
    .superRefine((value, context) => {
      if (
        value.dataType === "select" &&
        (!value.selectOptions || value.selectOptions.length === 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["selectOptions"],
          message: "Select fields require at least one option.",
        });
      }
      if (value.dataType !== "select" && value.selectOptions !== null) {
        context.addIssue({
          code: "custom",
          path: ["selectOptions"],
          message: "Only select fields may define selectOptions.",
        });
      }
    });

export const UpdateAffairExcelFieldSchema =
  AffairExcelFieldWriteBaseSchema.partial()
    .extend({ version: z.number().int().positive() })
    .strict();

export const DeleteAffairExcelFieldQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();

export const AffairCollectionBindingSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  collectionId: z.string().min(1),
  fieldId: z.string().min(1),
  isRequired: z.boolean(),
  sortOrder: z.number().int().nonnegative(),
  field: AffairExcelFieldSchema,
});

export const AffairCollectionBindingInputSchema = z
  .object({
    fieldId: z.string().trim().min(1),
    isRequired: z.boolean().default(false),
  })
  .strict();

export const ReplaceAffairCollectionBindingsSchema = z
  .object({
    bindings: z.array(AffairCollectionBindingInputSchema).max(500),
    layout: z.string().max(200000).optional(),
  })
  .strict();

/**
 * PHP reference rows are flat string maps. Form rows use header names as keys;
 * Excel rows use field_id strings as keys. They deliberately remain separate tables.
 */
export const AffairReferenceRowDataSchema = z.record(
  z.string().min(1).max(200),
  z.string().max(200000),
);

export const AffairReferenceDataRowSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  collectionId: z.string().min(1),
  rowData: AffairReferenceRowDataSchema,
  sortOrder: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
});

export const ReplaceAffairReferenceDataSchema = z
  .object({
    rows: z.array(AffairReferenceRowDataSchema).max(10000),
  })
  .strict();

export type AffairCollectionType = z.infer<typeof AffairCollectionTypeSchema>;
export type AffairCollectionTarget = z.infer<
  typeof AffairCollectionTargetSchema
>;
export type AffairCollectionSettings = z.infer<
  typeof AffairCollectionSettingsSchema
>;
export type AffairCollection = z.infer<typeof AffairCollectionSchema>;
export type AffairCollectionListQuery = z.infer<
  typeof AffairCollectionListQuerySchema
>;
export type CreateAffairCollectionInput = z.infer<
  typeof CreateAffairCollectionSchema
>;
export type UpdateAffairCollectionInput = z.infer<
  typeof UpdateAffairCollectionSchema
>;
export type AffairExcelFieldDataType = z.infer<
  typeof AffairExcelFieldDataTypeSchema
>;
export type AffairExcelFieldValidation = z.infer<
  typeof AffairExcelFieldValidationSchema
>;
export type AffairExcelField = z.infer<typeof AffairExcelFieldSchema>;
export type CreateAffairExcelFieldInput = z.infer<
  typeof CreateAffairExcelFieldSchema
>;
export type UpdateAffairExcelFieldInput = z.infer<
  typeof UpdateAffairExcelFieldSchema
>;
export type AffairCollectionBinding = z.infer<
  typeof AffairCollectionBindingSchema
>;
export type ReplaceAffairCollectionBindingsInput = z.infer<
  typeof ReplaceAffairCollectionBindingsSchema
>;
export type AffairReferenceRowData = z.infer<
  typeof AffairReferenceRowDataSchema
>;
export type AffairReferenceDataRow = z.infer<
  typeof AffairReferenceDataRowSchema
>;
export type ReplaceAffairReferenceDataInput = z.infer<
  typeof ReplaceAffairReferenceDataSchema
>;
