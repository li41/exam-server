import type { ExamineeImportIssue } from "@server-foundation/api-contracts";
import {
  PayloadTooLargeError,
  type ExamineeService,
  type QuestionBankScope,
} from "@server-foundation/domain";
import {
  MAX_EXAMINEE_IMPORT_BYTES,
  parseExamineeImportWorkbook,
} from "./examinee-import.js";

export type ExamineeImportFailure = {
  ok: false;
  imported: 0;
  updated: 0;
  errors: ExamineeImportIssue[];
};

export type ExamineeImportSuccess = {
  ok: true;
  imported: number;
  updated: number;
  errors: [];
};

export type ExamineeImportResult =
  ExamineeImportFailure | ExamineeImportSuccess;

const failure = (message: string): ExamineeImportFailure => ({
  ok: false,
  imported: 0,
  updated: 0,
  errors: [{ sheet: null, row: null, identifier: null, message }],
});

const uploadedFile = async (request: Request): Promise<File | null> => {
  try {
    const form = await request.formData();
    const upload = form.get("file");
    return upload instanceof File ? upload : null;
  } catch {
    return null;
  }
};

export const examineeImportFingerprintPayload = async (
  request: Request,
): Promise<Buffer | null> => {
  const upload = await uploadedFile(request);
  if (!upload) return null;
  if (upload.size > MAX_EXAMINEE_IMPORT_BYTES) throw new PayloadTooLargeError();
  const filename = Buffer.from(upload.name, "utf8");
  const bytes = Buffer.from(await upload.arrayBuffer());
  return Buffer.concat([filename, Buffer.from([0]), bytes]);
};

export const importExamineeWorkbookFromRequest = async (
  request: Request,
  service: ExamineeService,
  scope: QuestionBankScope,
): Promise<ExamineeImportResult> => {
  const upload = await uploadedFile(request);
  if (!upload) {
    return failure("請使用 multipart/form-data 並以 file 欄位上傳試算表。");
  }
  if (upload.size > MAX_EXAMINEE_IMPORT_BYTES) throw new PayloadTooLargeError();

  const groups = await service.listGroups({}, scope);
  const parsed = parseExamineeImportWorkbook(
    Buffer.from(await upload.arrayBuffer()),
    upload.name,
    groups,
  );
  if (parsed.errors.length > 0) {
    return { ok: false, imported: 0, updated: 0, errors: parsed.errors };
  }

  const written = await service.importExaminees(parsed.rows, scope);
  if (written.errors.length > 0) {
    return {
      ok: false,
      imported: 0,
      updated: 0,
      errors: written.errors,
    };
  }
  return {
    ok: true,
    imported: written.imported,
    updated: written.updated,
    errors: [],
  };
};
