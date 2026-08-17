import { z } from "zod";

export const AffairStatusSchema = z.enum(["enabled", "disabled"]);
export const AffairSchoolLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export const AffairBriefingRegionSchema = z.enum([
  "north",
  "central",
  "south",
  "east",
  "online",
]);

const NullableDateTimeSchema = z.string().min(1).nullable();
const NullableTextSchema = z.string().nullable();
const NullableJsonSchema = z.unknown().nullable();

export const AffairSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  createdBy: z.string().min(1),
  name: z.string().min(1).max(200),
  description: NullableTextSchema,
  status: AffairStatusSchema,
  cityLoginStart: NullableDateTimeSchema,
  cityLoginEnd: NullableDateTimeSchema,
  schoolLoginStart: NullableDateTimeSchema,
  schoolLoginEnd: NullableDateTimeSchema,
  feeCityContact: z.number().int().nonnegative(),
  feeSchoolContact: z.number().int().nonnegative(),
  feeTeacherSetup: z.number().int().nonnegative(),
  feeTeacherMonitor1: z.number().int().nonnegative(),
  feeTeacherMonitor2: z.number().int().nonnegative(),
  feeTeacherMonitor3: z.number().int().nonnegative(),
  transportReceiptSchool: z.boolean(),
  transportReceiptCity: z.boolean(),
  briefingRegions: NullableJsonSchema,
  receiptYear: z.string().max(10).nullable(),
  receiptNote: z.string().max(500).nullable(),
  receiptPrintSchool: z.boolean(),
  receiptPrintCity: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const AffairWriteFieldsBaseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(200000).nullable(),
  status: AffairStatusSchema,
  cityLoginStart: NullableDateTimeSchema,
  cityLoginEnd: NullableDateTimeSchema,
  schoolLoginStart: NullableDateTimeSchema,
  schoolLoginEnd: NullableDateTimeSchema,
  feeCityContact: z.number().int().nonnegative(),
  feeSchoolContact: z.number().int().nonnegative(),
  feeTeacherSetup: z.number().int().nonnegative(),
  feeTeacherMonitor1: z.number().int().nonnegative(),
  feeTeacherMonitor2: z.number().int().nonnegative(),
  feeTeacherMonitor3: z.number().int().nonnegative(),
  transportReceiptSchool: z.boolean(),
  transportReceiptCity: z.boolean(),
  briefingRegions: NullableJsonSchema,
  receiptYear: z.string().trim().max(10).nullable(),
  receiptNote: z.string().trim().max(500).nullable(),
  receiptPrintSchool: z.boolean(),
  receiptPrintCity: z.boolean(),
});

export const CreateAffairSchema = AffairWriteFieldsBaseSchema.extend({
  description: AffairWriteFieldsBaseSchema.shape.description.default(null),
  status: AffairWriteFieldsBaseSchema.shape.status.default("enabled"),
  cityLoginStart: AffairWriteFieldsBaseSchema.shape.cityLoginStart.default(null),
  cityLoginEnd: AffairWriteFieldsBaseSchema.shape.cityLoginEnd.default(null),
  schoolLoginStart:
    AffairWriteFieldsBaseSchema.shape.schoolLoginStart.default(null),
  schoolLoginEnd: AffairWriteFieldsBaseSchema.shape.schoolLoginEnd.default(null),
  feeCityContact: AffairWriteFieldsBaseSchema.shape.feeCityContact.default(0),
  feeSchoolContact: AffairWriteFieldsBaseSchema.shape.feeSchoolContact.default(0),
  feeTeacherSetup: AffairWriteFieldsBaseSchema.shape.feeTeacherSetup.default(0),
  feeTeacherMonitor1:
    AffairWriteFieldsBaseSchema.shape.feeTeacherMonitor1.default(0),
  feeTeacherMonitor2:
    AffairWriteFieldsBaseSchema.shape.feeTeacherMonitor2.default(0),
  feeTeacherMonitor3:
    AffairWriteFieldsBaseSchema.shape.feeTeacherMonitor3.default(0),
  transportReceiptSchool:
    AffairWriteFieldsBaseSchema.shape.transportReceiptSchool.default(false),
  transportReceiptCity:
    AffairWriteFieldsBaseSchema.shape.transportReceiptCity.default(false),
  briefingRegions:
    AffairWriteFieldsBaseSchema.shape.briefingRegions.default(null),
  receiptYear: AffairWriteFieldsBaseSchema.shape.receiptYear.default(null),
  receiptNote: AffairWriteFieldsBaseSchema.shape.receiptNote.default(null),
  receiptPrintSchool:
    AffairWriteFieldsBaseSchema.shape.receiptPrintSchool.default(false),
  receiptPrintCity:
    AffairWriteFieldsBaseSchema.shape.receiptPrintCity.default(false),
});

export const UpdateAffairSchema = AffairWriteFieldsBaseSchema.partial().extend({
  version: z.number().int().positive(),
});

export const AffairListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  status: AffairStatusSchema.optional(),
});

export const DeleteAffairQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
});

export const AffairCitySchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  cityCode: z.string().min(1).max(10),
  cityName: z.string().min(1).max(10),
  account: z.string().min(1).max(20),
  password: z.string().min(1).max(50),
  contactName: z.string().max(50).nullable(),
  email: z.string().email().max(255).nullable(),
  phone: z.string().max(30).nullable(),
  setupCompleted: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const UpdateAffairCitySchema = z.object({
  password: z.string().trim().min(1).max(50).optional(),
  contactName: z.string().trim().max(50).nullable().optional(),
  email: z.string().trim().email().max(255).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  version: z.number().int().positive(),
});

export const InitializeAffairCitiesResponseSchema = z.object({
  created: z.number().int().nonnegative(),
  items: z.array(AffairCitySchema),
});

export const AffairSchoolSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  affairId: z.string().min(1),
  city: z.string().min(1).max(10),
  schoolLevel: AffairSchoolLevelSchema,
  schoolCode: z.string().min(1).max(20),
  schoolName: z.string().min(1).max(100),
  testClasses: z.union([z.literal(1), z.literal(2)]),
  testSessions: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  receiptCode: z.string().regex(/^\d{3}$/).nullable(),
  briefingOptions: z.array(z.string().min(1)).nullable(),
  password: z.string().min(1).max(50),
  contacts: NullableJsonSchema,
  setupCompleted: z.array(z.enum(["SC", "SD", "SE"])).nullable(),
  status: AffairStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const AffairSchoolWriteFieldsBaseSchema = z.object({
  city: z.string().trim().min(1).max(10),
  schoolLevel: AffairSchoolLevelSchema,
  schoolCode: z.string().trim().min(1).max(20),
  schoolName: z.string().trim().min(1).max(100),
  testClasses: z.union([z.literal(1), z.literal(2)]),
  testSessions: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  receiptCode: z.string().trim().regex(/^\d{3}$/).nullable(),
  briefingOptions: z.array(z.string().trim().min(1).max(50)).max(20).nullable(),
  password: z.string().trim().max(50).nullable(),
  status: AffairStatusSchema,
});

export const CreateAffairSchoolSchema = AffairSchoolWriteFieldsBaseSchema.extend({
  affairId: z.string().trim().min(1),
  testClasses: AffairSchoolWriteFieldsBaseSchema.shape.testClasses.default(1),
  testSessions: AffairSchoolWriteFieldsBaseSchema.shape.testSessions.default(1),
  receiptCode: AffairSchoolWriteFieldsBaseSchema.shape.receiptCode.default(null),
  briefingOptions:
    AffairSchoolWriteFieldsBaseSchema.shape.briefingOptions.default(null),
  password: AffairSchoolWriteFieldsBaseSchema.shape.password.default(null),
  status: AffairSchoolWriteFieldsBaseSchema.shape.status.default("enabled"),
});

export const UpdateAffairSchoolSchema =
  AffairSchoolWriteFieldsBaseSchema.partial().extend({
    version: z.number().int().positive(),
  });

export const AffairSchoolListQuerySchema = z.object({
  affairId: z.string().trim().min(1),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  city: z.string().trim().max(10).optional(),
  schoolLevel: AffairSchoolLevelSchema.optional(),
  search: z.string().trim().max(100).optional(),
  status: AffairStatusSchema.optional(),
});

export const DeleteAffairSchoolQuerySchema = z.object({
  version: z.coerce.number().int().positive(),
});

export type AffairStatus = z.infer<typeof AffairStatusSchema>;
export type Affair = z.infer<typeof AffairSchema>;
export type AffairListQuery = z.infer<typeof AffairListQuerySchema>;
export type CreateAffairInput = z.infer<typeof CreateAffairSchema>;
export type UpdateAffairInput = z.infer<typeof UpdateAffairSchema>;
export type AffairCity = z.infer<typeof AffairCitySchema>;
export type UpdateAffairCityInput = z.infer<typeof UpdateAffairCitySchema>;
export type InitializeAffairCitiesResponse = z.infer<
  typeof InitializeAffairCitiesResponseSchema
>;
export type AffairSchool = z.infer<typeof AffairSchoolSchema>;
export type AffairSchoolListQuery = z.infer<typeof AffairSchoolListQuerySchema>;
export type CreateAffairSchoolInput = z.infer<typeof CreateAffairSchoolSchema>;
export type UpdateAffairSchoolInput = z.infer<typeof UpdateAffairSchoolSchema>;
