import { z } from "zod";

export const AffairSubmissionStatusSchema = z.enum([
  "draft",
  "submitted",
  "returned",
]);
export const AffairSubmissionSubmitterTypeSchema = z.enum(["school", "city"]);
export const AffairSubmissionAccountTypeSchema = z.enum([
  "SC",
  "SD",
  "SE",
  "EDU",
]);

export const AffairSubmissionSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    affairId: z.string().min(1),
    collectionId: z.string().min(1),
    submitterType: AffairSubmissionSubmitterTypeSchema,
    schoolId: z.string().min(1).nullable(),
    cityId: z.string().min(1).nullable(),
    accountType: AffairSubmissionAccountTypeSchema.nullable(),
    status: AffairSubmissionStatusSchema,
    returnReason: z.string().max(500).nullable(),
    returnedAt: z.string().min(1).nullable(),
    submittedAt: z.string().min(1).nullable(),
    version: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

const SubmissionIdentityBase = {
  affairId: z.string().trim().min(1),
  collectionId: z.string().trim().min(1),
};

export const EnsureAffairSubmissionSchema = z.discriminatedUnion(
  "submitterType",
  [
    z
      .object({
        ...SubmissionIdentityBase,
        submitterType: z.literal("school"),
        schoolId: z.string().trim().min(1),
        accountType: z.literal("SC").default("SC"),
      })
      .strict(),
    z
      .object({
        ...SubmissionIdentityBase,
        submitterType: z.literal("city"),
        cityId: z.string().trim().min(1),
        accountType: z.literal("EDU").default("EDU"),
      })
      .strict(),
  ],
);

export const EnsureAffairSubmissionResponseSchema = z
  .object({
    created: z.boolean(),
    item: AffairSubmissionSchema,
  })
  .strict();

export const AffairSubmissionListQuerySchema = z
  .object({
    collectionId: z.string().trim().min(1),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: AffairSubmissionStatusSchema.optional(),
    submitterType: AffairSubmissionSubmitterTypeSchema.optional(),
  })
  .strict();

export const AffairSubmissionFieldValueSchema = z
  .object({
    fieldId: z.string().trim().min(1),
    value: z.string().max(200000),
  })
  .strict();

/**
 * PHP stores row_data as a field_id -> string JSON map. The key space is dynamic,
 * so the contract constrains values here and the use case additionally rejects
 * every key that is not currently bound to the collection.
 */
export const AffairSubmissionRowValuesSchema = z.record(
  z.string().min(1),
  z.string().max(200000),
);

export const AffairSubmissionRowSchema = z
  .object({
    id: z.string().min(1),
    submissionId: z.string().min(1),
    values: AffairSubmissionRowValuesSchema,
    sortOrder: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
  })
  .strict();

export const AffairSubmissionWritePayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("form"),
      fields: z.array(AffairSubmissionFieldValueSchema).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("excel"),
      rows: z
        .array(
          z
            .object({ values: AffairSubmissionRowValuesSchema })
            .strict(),
        )
        .max(10000),
    })
    .strict(),
]);

export const AffairSubmissionPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("form"),
      fields: z.array(AffairSubmissionFieldValueSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("excel"),
      rows: z.array(AffairSubmissionRowSchema),
    })
    .strict(),
]);

export const AffairSubmissionDetailSchema = AffairSubmissionSchema.extend({
  payload: AffairSubmissionPayloadSchema,
}).strict();

export const SaveAffairSubmissionSchema = z
  .object({
    version: z.number().int().positive(),
    payload: AffairSubmissionWritePayloadSchema,
  })
  .strict();

export const ReturnAffairSubmissionSchema = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

export const BatchReturnAffairSubmissionsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

export const BatchReturnAffairSubmissionsResponseSchema = z
  .object({
    returned: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();

export const DeleteAffairSubmissionQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();

export type AffairSubmissionStatus = z.infer<
  typeof AffairSubmissionStatusSchema
>;
export type AffairSubmissionSubmitterType = z.infer<
  typeof AffairSubmissionSubmitterTypeSchema
>;
export type AffairSubmissionAccountType = z.infer<
  typeof AffairSubmissionAccountTypeSchema
>;
export type AffairSubmission = z.infer<typeof AffairSubmissionSchema>;
export type AffairSubmissionDetail = z.infer<
  typeof AffairSubmissionDetailSchema
>;
export type AffairSubmissionListQuery = z.infer<
  typeof AffairSubmissionListQuerySchema
>;
export type EnsureAffairSubmissionInput = z.infer<
  typeof EnsureAffairSubmissionSchema
>;
export type AffairSubmissionFieldValue = z.infer<
  typeof AffairSubmissionFieldValueSchema
>;
export type AffairSubmissionRow = z.infer<typeof AffairSubmissionRowSchema>;
export type AffairSubmissionWritePayload = z.infer<
  typeof AffairSubmissionWritePayloadSchema
>;
export type AffairSubmissionPayload = z.infer<
  typeof AffairSubmissionPayloadSchema
>;
export type SaveAffairSubmissionInput = z.infer<
  typeof SaveAffairSubmissionSchema
>;
export type ReturnAffairSubmissionInput = z.infer<
  typeof ReturnAffairSubmissionSchema
>;
export type BatchReturnAffairSubmissionsInput = z.infer<
  typeof BatchReturnAffairSubmissionsSchema
>;
