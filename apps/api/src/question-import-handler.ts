import {
  PayloadTooLargeError,
  type QuestionBankScope,
  type QuestionImportService,
} from "@server-foundation/domain";
import {
  buildQuestionImportTemplate,
  MAX_QUESTION_IMPORT_BYTES,
  parseQuestionImportWorkbook,
  QUESTION_IMPORT_TEMPLATE_FILENAME,
} from "./question-import.js";
import type { QuestionImportIssue } from "./question-import.js";

export type QuestionImportFailure = {
  ok: false;
  imported: 0;
  errors: QuestionImportIssue[];
};

export type QuestionImportSuccess = {
  ok: true;
  imported: number;
  errors: [];
};

export type QuestionImportResult = QuestionImportFailure | QuestionImportSuccess;

const failure = (message: string): QuestionImportFailure => ({
  ok: false,
  imported: 0,
  errors: [{ sheet: null, row: null, code: null, message }],
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

export const questionImportFingerprintPayload = async (
  request: Request,
): Promise<Buffer | null> => {
  const upload = await uploadedFile(request);
  if (!upload) return null;
  if (upload.size > MAX_QUESTION_IMPORT_BYTES) throw new PayloadTooLargeError();
  const filename = Buffer.from(upload.name, "utf8");
  const bytes = Buffer.from(await upload.arrayBuffer());
  return Buffer.concat([filename, Buffer.from([0]), bytes]);
};

export const questionImportTemplateResponse = (): Response => {
  const body = buildQuestionImportTemplate();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${QUESTION_IMPORT_TEMPLATE_FILENAME}"`,
      "Content-Length": String(body.byteLength),
    },
  });
};

export const importQuestionWorkbookFromRequest = async (
  request: Request,
  service: QuestionImportService,
  scope: QuestionBankScope,
): Promise<QuestionImportResult> => {
  const upload = await uploadedFile(request);
  if (!upload) {
    return failure("請使用 multipart/form-data 並以 file 欄位上傳試算表。");
  }
  if (upload.size > MAX_QUESTION_IMPORT_BYTES) throw new PayloadTooLargeError();

  const categories = await service.listCategories(scope);
  const parsed = parseQuestionImportWorkbook(
    Buffer.from(await upload.arrayBuffer()),
    upload.name,
    categories,
  );

  const existingCodes = await service.findExistingQuestionCodes(
    parsed.rows.map((row) => row.input.code),
    scope,
  );
  if (existingCodes.length > 0) {
    const existing = new Set(existingCodes);
    for (const row of parsed.rows) {
      if (existing.has(row.input.code)) {
        parsed.errors.push({
          sheet: row.sheet,
          row: row.row,
          code: row.input.code,
          message: `code「${row.input.code}」已存在於此租戶。`,
        });
      }
    }
  }

  if (parsed.errors.length > 0) {
    return { ok: false, imported: 0, errors: parsed.errors };
  }

  const imported = await service.importQuestions(
    parsed.rows.map((row) => row.input),
    scope,
  );
  return { ok: true, imported, errors: [] };
};
