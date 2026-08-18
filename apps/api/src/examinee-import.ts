import { extname } from "node:path";
import * as XLSX from "@e965/xlsx";
import {
  CreateExamineeSchema,
  type CreateExamineeInput,
  type ExamineeGroup,
  type ExamineeImportIssue,
} from "@server-foundation/api-contracts";
import type { ExamineeImportRecord } from "@server-foundation/domain";

export const MAX_EXAMINEE_IMPORT_BYTES = 10 * 1024 * 1024;

export type ExamineeImportParseResult = {
  rows: ExamineeImportRecord[];
  errors: ExamineeImportIssue[];
};

const text = (value: unknown): string => String(value ?? "").trim();

const issue = (
  sheet: string | null,
  row: number | null,
  identifier: string | null,
  message: string,
): ExamineeImportIssue => ({ sheet, row, identifier, message });

const groupResolver = (groups: ExamineeGroup[]) => {
  const map = new Map<string, string>();
  const parentNames = new Map<string, string>();
  for (const group of groups) {
    if (group.parentId === null) {
      parentNames.set(group.id, group.name);
      map.set(group.name, group.id);
    }
  }
  for (const group of groups) {
    if (group.parentId !== null) {
      map.set(group.name, group.id);
      const parentName = parentNames.get(group.parentId);
      if (parentName) map.set(`${parentName}/${group.name}`, group.id);
    }
  }
  return (name: string): string | null =>
    name ? (map.get(name) ?? null) : null;
};

const zodMessage = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string =>
  error.issues
    .map((entry) => {
      const path = entry.path.map(String).join(".");
      return path ? `${path}: ${entry.message}` : entry.message;
    })
    .join("; ");

export const parseExamineeImportWorkbook = (
  buffer: Buffer,
  filename: string,
  groups: ExamineeGroup[],
): ExamineeImportParseResult => {
  const errors: ExamineeImportIssue[] = [];
  const rows: ExamineeImportRecord[] = [];
  const extension = extname(filename).toLowerCase();
  if (extension !== ".xlsx" && extension !== ".ods") {
    return {
      rows,
      errors: [issue(null, null, null, "只支援 .xlsx 或 .ods 檔案。")],
    };
  }
  if (buffer.byteLength > MAX_EXAMINEE_IMPORT_BYTES) {
    return {
      rows,
      errors: [issue(null, null, null, "檔案大小不可超過 10MB。")],
    };
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch (error) {
    return {
      rows,
      errors: [
        issue(
          null,
          null,
          null,
          `無法讀取試算表：${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { rows, errors: [issue(null, null, null, "試算表沒有工作表。")] };
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return {
      rows,
      errors: [issue(sheetName, null, null, "無法讀取第一個工作表。")],
    };
  }
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  }) as unknown[][];
  if (matrix.length < 2) {
    return {
      rows,
      errors: [issue(sheetName, null, null, "檔案內容為空或僅有標題列。")],
    };
  }

  const headerRow = (matrix[0] ?? []).map(text);
  const positions = new Map(headerRow.map((name, index) => [name, index]));
  for (const required of ["姓名", "代號", "密碼"]) {
    if (!positions.has(required)) {
      errors.push(issue(sheetName, 1, null, `缺少必要欄位「${required}」。`));
    }
  }
  if (["姓名", "代號", "密碼"].some((name) => !positions.has(name))) {
    return { rows, errors };
  }

  const resolveGroup = groupResolver(groups);
  const getCell = (values: unknown[], name: string): string => {
    const index = positions.get(name);
    return index === undefined ? "" : text(values[index]);
  };

  for (let index = 1; index < matrix.length; index += 1) {
    const values = matrix[index] ?? [];
    if (values.every((value) => text(value) === "")) continue;
    const row = index + 1;
    const name = getCell(values, "姓名");
    const identifier = getCell(values, "代號");
    const code = getCell(values, "密碼");
    if (!name) {
      errors.push(issue(sheetName, row, identifier || null, "姓名為必填。"));
      continue;
    }
    if (!identifier) {
      errors.push(issue(sheetName, row, null, "代號為必填。"));
      continue;
    }
    if (!code) {
      errors.push(issue(sheetName, row, identifier, "密碼為必填。"));
      continue;
    }
    if (name.length > 100) {
      errors.push(issue(sheetName, row, identifier, "姓名不可超過 100 字。"));
      continue;
    }
    if (identifier.length > 100) {
      errors.push(issue(sheetName, row, identifier, "代號不可超過 100 字。"));
      continue;
    }
    if (code.length > 50) {
      errors.push(issue(sheetName, row, identifier, "密碼不可超過 50 字。"));
      continue;
    }

    const groupName = getCell(values, "群組");
    const groupId = resolveGroup(groupName);
    if (groupName && groupId === null) {
      errors.push(
        issue(
          sheetName,
          row,
          identifier,
          `找不到群組「${groupName}」，請先建立。`,
        ),
      );
      continue;
    }
    const statusText = getCell(values, "狀態");
    const status =
      statusText === "停用" || statusText === "0" ? "disabled" : "enabled";
    const noteText = getCell(values, "備註");
    const candidate: CreateExamineeInput = {
      groupId,
      code,
      identifier,
      name,
      note: noteText || null,
      status,
    };
    const validated = CreateExamineeSchema.safeParse(candidate);
    if (!validated.success) {
      errors.push(
        issue(sheetName, row, identifier, zodMessage(validated.error)),
      );
      continue;
    }
    rows.push({ sheet: sheetName, row, input: validated.data });
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push(issue(sheetName, null, null, "沒有可匯入的資料。"));
    return { rows, errors };
  }

  const identifierRows = new Map<string, ExamineeImportRecord[]>();
  const codeRows = new Map<string, ExamineeImportRecord[]>();
  for (const record of rows) {
    const identifiers = identifierRows.get(record.input.identifier) ?? [];
    identifiers.push(record);
    identifierRows.set(record.input.identifier, identifiers);
    const codes = codeRows.get(record.input.code) ?? [];
    codes.push(record);
    codeRows.set(record.input.code, codes);
  }
  for (const [identifier, duplicates] of identifierRows) {
    if (duplicates.length < 2) continue;
    for (const record of duplicates) {
      errors.push(
        issue(
          record.sheet,
          record.row,
          record.input.identifier,
          `代號「${identifier}」在匯入檔案中重複出現。`,
        ),
      );
    }
  }
  for (const duplicates of codeRows.values()) {
    if (duplicates.length < 2) continue;
    for (const record of duplicates) {
      errors.push(
        issue(
          record.sheet,
          record.row,
          record.input.identifier,
          "密碼在匯入檔案中重複出現。",
        ),
      );
    }
  }
  return { rows, errors };
};
