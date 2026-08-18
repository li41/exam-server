import { z } from "zod";

export const AffairReceiptSubmitterTypeSchema = z.enum(["school", "city"]);
export const AffairReceiptActorTypeSchema = z.enum([
  "backend",
  "school",
  "city",
]);
export const AffairReceiptAccessActionSchema = z.enum([
  "list",
  "view",
  "print",
  "export",
  "delete",
]);
export const AffairReceiptPositionSchema = z.enum([
  "學校聯絡人",
  "監考或資訊教師",
  "無擔任",
]);
export const AffairReceiptTransportTypeSchema = z.enum([
  "rail",
  "island",
  "none",
]);
export const AffairReceiptBriefingRegionSchema = z.enum([
  "north",
  "central",
  "south",
  "east",
  "online",
]);

const ReceiptWriteFieldsBaseSchema = z.object({
  name: z.string().trim().min(1).max(50),
  jobTitle: z.string().trim().min(1).max(50),
  idNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][1289]\d{8}$/u),
  residentCert: z.string().trim().max(20).nullable(),
  taxId: z.string().trim().max(20).nullable(),
  phoneArea: z.string().trim().min(1).max(5),
  phoneNumber: z.string().trim().min(1).max(15),
  phoneExt: z.string().trim().max(10).nullable(),
  mobile: z
    .string()
    .trim()
    .regex(/^09\d{8}$/u),
  email: z.string().trim().email().max(255),
  addrCity: z.string().trim().min(1).max(10),
  addrDistrict: z.string().trim().min(1).max(10),
  addrDetail: z.string().trim().min(1).max(200),
  bankId: z
    .string()
    .trim()
    .regex(/^\d{3}$/u),
  bankSubid: z
    .string()
    .trim()
    .regex(/^\d{4}$/u),
  bankAccount: z.string().trim().min(1).max(30),
  bankbookFileId: z.string().trim().min(1),
  positions: z.array(AffairReceiptPositionSchema).max(3),
  monitorClasses: z.number().int().min(1).max(3).nullable(),
  briefingRegion: AffairReceiptBriefingRegionSchema.nullable(),
  transportType: AffairReceiptTransportTypeSchema.nullable(),
  transportOriginArea: z.string().trim().max(10).nullable(),
  transportOriginStation: z.string().trim().max(10).nullable(),
  transportDestStation: z.string().trim().max(10).nullable(),
  transportFee: z.number().int().nonnegative().nullable(),
  agreed: z.boolean(),
});

const CreateReceiptWriteFieldsSchema = ReceiptWriteFieldsBaseSchema.extend({
  residentCert: ReceiptWriteFieldsBaseSchema.shape.residentCert.default(null),
  taxId: ReceiptWriteFieldsBaseSchema.shape.taxId.default(null),
  phoneExt: ReceiptWriteFieldsBaseSchema.shape.phoneExt.default(null),
  positions: ReceiptWriteFieldsBaseSchema.shape.positions.default([]),
  monitorClasses:
    ReceiptWriteFieldsBaseSchema.shape.monitorClasses.default(null),
  briefingRegion:
    ReceiptWriteFieldsBaseSchema.shape.briefingRegion.default(null),
  transportType: ReceiptWriteFieldsBaseSchema.shape.transportType.default(null),
  transportOriginArea:
    ReceiptWriteFieldsBaseSchema.shape.transportOriginArea.default(null),
  transportOriginStation:
    ReceiptWriteFieldsBaseSchema.shape.transportOriginStation.default(null),
  transportDestStation:
    ReceiptWriteFieldsBaseSchema.shape.transportDestStation.default(null),
  transportFee: ReceiptWriteFieldsBaseSchema.shape.transportFee.default(null),
  agreed: ReceiptWriteFieldsBaseSchema.shape.agreed.default(false),
});

const CreateReceiptIdentityBase = {
  affairId: z.string().trim().min(1),
  account: z.string().trim().min(1).max(30),
  ...CreateReceiptWriteFieldsSchema.shape,
};

export const CreateAffairReceiptSchema = z.discriminatedUnion("submitterType", [
  z
    .object({
      ...CreateReceiptIdentityBase,
      submitterType: z.literal("school"),
      schoolId: z.string().trim().min(1),
      accountType: z.enum(["SC", "SD", "SE"]),
    })
    .strict(),
  z
    .object({
      ...CreateReceiptIdentityBase,
      submitterType: z.literal("city"),
      cityId: z.string().trim().min(1),
      accountType: z.literal("EDU"),
    })
    .strict(),
]);

export const UpdateAffairReceiptSchema = ReceiptWriteFieldsBaseSchema.partial()
  .extend({ version: z.number().int().positive() })
  .strict();

export const AffairReceiptListQuerySchema = z
  .object({
    affairId: z.string().trim().min(1),
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    submitterType: AffairReceiptSubmitterTypeSchema.optional(),
    keyword: z.string().trim().max(100).optional(),
  })
  .strict();

export const AffairReceiptListItemSchema = z
  .object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    affairId: z.string().min(1),
    submitterType: AffairReceiptSubmitterTypeSchema,
    schoolId: z.string().min(1).nullable(),
    cityId: z.string().min(1).nullable(),
    accountType: z.string().min(1).max(5),
    account: z.string().min(1).max(30),
    name: z.string().min(1).max(50),
    positions: z.array(AffairReceiptPositionSchema),
    monitorClasses: z.number().int().nullable(),
    briefingRegion: AffairReceiptBriefingRegionSchema.nullable(),
    transportType: AffairReceiptTransportTypeSchema.nullable(),
    transportFee: z.number().int().nonnegative().nullable(),
    agreed: z.boolean(),
    version: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

/** Internal domain/repository detail. bankbookFileId never has to leave the API. */
export const AffairReceiptDetailSchema = AffairReceiptListItemSchema.extend({
  jobTitle: z.string(),
  idNumber: z.string(),
  residentCert: z.string().nullable(),
  taxId: z.string().nullable(),
  phoneArea: z.string(),
  phoneNumber: z.string(),
  phoneExt: z.string().nullable(),
  mobile: z.string(),
  email: z.string(),
  addrCity: z.string(),
  addrDistrict: z.string(),
  addrDetail: z.string(),
  bankId: z.string(),
  bankSubid: z.string(),
  bankAccount: z.string(),
  bankbookFileId: z.string().min(1),
  transportOriginArea: z.string().nullable(),
  transportOriginStation: z.string().nullable(),
  transportDestStation: z.string().nullable(),
}).strict();

/** Public detail/offline-copy shape. The bankbook is only available via the audited download endpoint. */
export const AffairReceiptPublicDetailSchema = AffairReceiptDetailSchema.omit({
  bankbookFileId: true,
}).strict();

export const AffairReceiptLookupSchema = z
  .object({
    affairId: z.string().trim().min(1),
    idNumber: z.string().trim().toUpperCase().min(1).max(20),
  })
  .strict();
export const AffairReceiptSelectionSchema = z
  .object({
    affairId: z.string().trim().min(1),
    ids: z.array(z.string().trim().min(1)).max(1000).default([]),
  })
  .strict();
export const DeleteAffairReceiptQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();

export type AffairReceiptSubmitterType = z.infer<
  typeof AffairReceiptSubmitterTypeSchema
>;
export type AffairReceiptActorType = z.infer<
  typeof AffairReceiptActorTypeSchema
>;
export type AffairReceiptAccessAction = z.infer<
  typeof AffairReceiptAccessActionSchema
>;
export type AffairReceiptPosition = z.infer<typeof AffairReceiptPositionSchema>;
export type AffairReceiptListQuery = z.infer<
  typeof AffairReceiptListQuerySchema
>;
export type AffairReceiptListItem = z.infer<typeof AffairReceiptListItemSchema>;
export type AffairReceiptDetail = z.infer<typeof AffairReceiptDetailSchema>;
export type AffairReceiptPublicDetail = z.infer<
  typeof AffairReceiptPublicDetailSchema
>;
export type CreateAffairReceiptInput = z.infer<
  typeof CreateAffairReceiptSchema
>;
export type UpdateAffairReceiptInput = z.infer<
  typeof UpdateAffairReceiptSchema
>;
export type AffairReceiptLookupInput = z.infer<
  typeof AffairReceiptLookupSchema
>;
export type AffairReceiptSelectionInput = z.infer<
  typeof AffairReceiptSelectionSchema
>;
