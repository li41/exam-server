import { extname } from "node:path";
import * as XLSX from "@e965/xlsx";
import {
  CreateQuestionSchema,
  QuestionTypeSchema,
} from "@server-foundation/api-contracts";
import type {
  CreateQuestionInput,
  QuestionCategory,
  QuestionType,
} from "@server-foundation/api-contracts";
import { DomainError, validateKnownQuestionShape } from "@server-foundation/domain";

export const MAX_QUESTION_IMPORT_BYTES = 10 * 1024 * 1024;
export const QUESTION_IMPORT_TEMPLATE_FILENAME = "question-import-template.xlsx";

export type QuestionImportIssue = {
  sheet: QuestionType | null;
  row: number | null;
  code: string | null;
  message: string;
};

export type QuestionImportRow = {
  sheet: QuestionType;
  row: number;
  input: CreateQuestionInput;
};

export type QuestionImportParseResult = {
  rows: QuestionImportRow[];
  errors: QuestionImportIssue[];
};

const headers = [
  "code",
  "stem",
  "category",
  "difficulty",
  "points",
  "tags",
  "status",
  "explanation",
  "options_json",
  "answer_json",
  "ai_rubric_json",
] as const;

const difficultyMap = new Map<string, number>([
  ["極易", 1],
  ["易", 2],
  ["中", 3],
  ["難", 4],
  ["極難", 5],
  ["1", 1],
  ["2", 2],
  ["3", 3],
  ["4", 4],
  ["5", 5],
]);

const examples: Record<
  QuestionType,
  { stem: string; options: unknown; answer: unknown }
> = {
  true_false: {
    stem: "水的化學式是 H2O。",
    options: null,
    answer: { value: true },
  },
  single_choice: {
    stem: "1 + 1 = ?",
    options: [
      { id: "A", text: "2" },
      { id: "B", text: "3" },
    ],
    answer: { value: "A" },
  },
  multiple_choice: {
    stem: "哪些是質數？",
    options: [
      { id: "A", text: "2" },
      { id: "B", text: "3" },
      { id: "C", text: "4" },
    ],
    answer: { values: ["A", "B"] },
  },
  short_answer: {
    stem: "請寫出水的化學式。",
    options: null,
    answer: { sample_answer: "H2O", match_mode: "manual" },
  },
  matching: {
    stem: "請配對國家與首都。",
    options: [
      { id: "L1", text: "台灣" },
      { id: "L2", text: "日本" },
    ],
    answer: {
      right_items: ["台北", "東京"],
      pairs: [
        { left: "L1", right: "台北" },
        { left: "L2", right: "東京" },
      ],
    },
  },
  sorting: {
    stem: "請依數值由小到大排序。",
    options: [
      { id: "S1", text: "1" },
      { id: "S2", text: "2" },
    ],
    answer: { order: ["S1", "S2"] },
  },
  fill_blank: {
    stem: "台灣的首都是___。",
    options: null,
    answer: { blanks: ["台北"], mode: "exact" },
  },
  dropdown: {
    stem: "水的化學式是___。",
    options: null,
    answer: { blanks: [{ options: ["H2O", "CO2"], correct: 0 }] },
  },
  choice_short_answer: {
    stem: "請為每一列選擇答案。",
    options: [
      { id: "Q1", text: "第一列" },
      { id: "Q2", text: "第二列" },
    ],
    answer: {
      choices: ["是", "否"],
      rows: [
        { option_id: "Q1", choice: 0 },
        { option_id: "Q2", choice: 1 },
      ],
    },
  },
  math: {
    stem: "請計算 1 + 1。",
    options: null,
    answer: { latex: "2", scoring: "exact" },
  },
  drawing: {
    stem: "請在座標平面上作圖。",
    options: null,
    answer: { board: { xMin: 0, xMax: 10, yMin: 0, yMax: 10 } },
  },
  development_drawing: {
    stem: "請完成折線圖。",
    options: null,
    answer: {
      chart: {},
      lines: [{ name: "line-1", points: [[0, 0], [1, 1]] }],
    },
  },
  interactive: {
    stem: "<div>互動題內容</div>",
    options: null,
    answer: { fields: [] },
  },
  drag_drop: {
    stem: "太陽是一顆___。",
    options: [
      { id: "D1", text: "恆星" },
      { id: "D2", text: "行星" },
    ],
    answer: { blanks: ["D1"], reusable: false },
  },
};

const text = (value: unknown): string => String(value ?? "").trim();

const issue = (
  sheet: QuestionType | null,
  row: number | null,
  code: string | null,
  message: string,
): QuestionImportIssue => ({ sheet, row, code, message });

const parseJson = (
  raw: string,
  label: string,
  sheet: QuestionType,
  row: number,
  code: string | null,
  errors: QuestionImportIssue[],
  blankValue: unknown,
): unknown => {
  if (!raw) return blankValue;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    errors.push(issue(sheet, row, code, `${label} 不是合法 JSON。`));
    return blankValue;
  }
};

const categoryResolver = (categories: QuestionCategory[]) => {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const direct = new Map<string, QuestionCategory[]>();
  const paths = new Map<string, QuestionCategory>();
  for (const category of categories) {
    const sameName = direct.get(category.name) ?? [];
    sameName.push(category);
    direct.set(category.name, sameName);
    if (category.parentId) {
      const parent = byId.get(category.parentId);
      if (parent) paths.set(`${parent.name}/${category.name}`, category);
    } else {
      paths.set(category.name, category);
    }
  }
  return (name: string): { id: string | null; error?: string } => {
    if (!name) return { id: null };
    if (name.includes("/")) {
      const found = paths.get(name);
      return found
        ? { id: found.id }
        : { id: null, error: `找不到分類「${name}」。` };
    }
    const found = direct.get(name) ?? [];
    if (found.length === 1) return { id: found[0]?.id ?? null };
    if (found.length > 1) {
      return {
        id: null,
        error: `分類「${name}」不唯一，請使用「父分類/子分類」完整路徑。`,
      };
    }
    return { id: null, error: `找不到分類「${name}」。` };
  };
};

const zodMessage = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  error.issues
    .map((entry) => {
      const path = entry.path.map(String).join(".");
      return path ? `${path}: ${entry.message}` : entry.message;
    })
    .join("; ");

export const buildQuestionImportTemplate = (): Buffer => {
  const workbook = XLSX.utils.book_new();
  for (const type of QuestionTypeSchema.options) {
    const example = examples[type];
    const row = [
      `EXAMPLE-${type}`.slice(0, 50),
      example.stem,
      "",
      "3",
      "1",
      "example",
      "enabled",
      "請刪除此範例列後填入正式資料。",
      example.options === null ? "" : JSON.stringify(example.options),
      JSON.stringify(example.answer),
      "",
    ];
    const sheet = XLSX.utils.aoa_to_sheet([headers, row]);
    XLSX.utils.book_append_sheet(workbook, sheet, type);
  }
  const output = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as Uint8Array);
};

export const parseQuestionImportWorkbook = (
  buffer: Buffer,
  filename: string,
  categories: QuestionCategory[],
): QuestionImportParseResult => {
  const errors: QuestionImportIssue[] = [];
  const rows: QuestionImportRow[] = [];
  const extension = extname(filename).toLowerCase();
  if (extension !== ".xlsx" && extension !== ".ods") {
    return {
      rows,
      errors: [issue(null, null, null, "只支援 .xlsx 或 .ods 檔案。")],
    };
  }
  if (buffer.byteLength > MAX_QUESTION_IMPORT_BYTES) {
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

  const resolveCategory = categoryResolver(categories);
  let recognizedSheetCount = 0;
  for (const sheetName of workbook.SheetNames) {
    const typeResult = QuestionTypeSchema.safeParse(sheetName.trim());
    if (!typeResult.success) continue;
    const type = typeResult.data;
    recognizedSheetCount += 1;
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    }) as unknown[][];
    if (matrix.length === 0) continue;
    const headerRow = (matrix[0] ?? []).map(text);
    const positions = new Map(headerRow.map((name, index) => [name, index]));
    for (const required of ["code", "stem", "answer_json"]) {
      if (!positions.has(required)) {
        errors.push(issue(type, 1, null, `缺少必要欄位「${required}」。`));
      }
    }
    if (["code", "stem", "answer_json"].some((name) => !positions.has(name))) {
      continue;
    }

    const getCell = (values: unknown[], name: string): string => {
      const index = positions.get(name);
      return index === undefined ? "" : text(values[index]);
    };

    for (let index = 1; index < matrix.length; index += 1) {
      const values = matrix[index] ?? [];
      if (values.every((value) => text(value) === "")) continue;
      const rowNumber = index + 1;
      const codeText = getCell(values, "code");
      const code = codeText || null;
      const stem = getCell(values, "stem");
      if (!codeText) {
        errors.push(issue(type, rowNumber, null, "code 為必填。"));
        continue;
      }
      if (!stem) {
        errors.push(issue(type, rowNumber, code, "stem 為必填。"));
        continue;
      }

      const difficultyText = getCell(values, "difficulty");
      const difficulty = difficultyText ? difficultyMap.get(difficultyText) : 3;
      if (difficulty === undefined) {
        errors.push(
          issue(type, rowNumber, code, "difficulty 必須是 1~5 或 極易/易/中/難/極難。"),
        );
        continue;
      }
      const pointsText = getCell(values, "points");
      const points = pointsText ? Number(pointsText) : 1;
      if (!Number.isFinite(points) || points <= 0 || points > 9999.9) {
        errors.push(issue(type, rowNumber, code, "points 必須是 0 到 9999.9 之間的正數。"));
        continue;
      }

      const statusText = getCell(values, "status").toLowerCase();
      let status: "enabled" | "disabled" = "enabled";
      if (["disabled", "停用", "0"].includes(statusText)) status = "disabled";
      else if (statusText && !["enabled", "啟用", "1"].includes(statusText)) {
        errors.push(issue(type, rowNumber, code, "status 必須是 enabled/disabled、啟用/停用 或 1/0。"));
        continue;
      }

      const categoryName = getCell(values, "category");
      const category = resolveCategory(categoryName);
      if (category.error) {
        errors.push(issue(type, rowNumber, code, category.error));
        continue;
      }

      const beforeJsonErrors = errors.length;
      const options = parseJson(
        getCell(values, "options_json"),
        "options_json",
        type,
        rowNumber,
        code,
        errors,
        null,
      );
      const answerText = getCell(values, "answer_json");
      if (!answerText) {
        errors.push(issue(type, rowNumber, code, "answer_json 為必填。"));
      }
      const answer = parseJson(
        answerText,
        "answer_json",
        type,
        rowNumber,
        code,
        errors,
        {},
      );
      const aiRubric = parseJson(
        getCell(values, "ai_rubric_json"),
        "ai_rubric_json",
        type,
        rowNumber,
        code,
        errors,
        null,
      );
      if (errors.length !== beforeJsonErrors) continue;

      const candidate = CreateQuestionSchema.safeParse({
        code: codeText,
        categoryId: category.id,
        type,
        difficulty,
        stem,
        options,
        answer,
        explanation: getCell(values, "explanation") || null,
        aiRubric,
        points,
        tags: getCell(values, "tags")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        status,
      });
      if (!candidate.success) {
        errors.push(issue(type, rowNumber, code, zodMessage(candidate.error)));
        continue;
      }
      try {
        validateKnownQuestionShape({
          type: candidate.data.type,
          stem: candidate.data.stem,
          options: candidate.data.options,
          answer: candidate.data.answer,
        });
      } catch (error) {
        errors.push(
          issue(
            type,
            rowNumber,
            code,
            error instanceof DomainError ? error.message : String(error),
          ),
        );
        continue;
      }
      rows.push({ sheet: type, row: rowNumber, input: candidate.data });
    }
  }

  if (recognizedSheetCount === 0) {
    errors.push(
      issue(
        null,
        null,
        null,
        "找不到可匯入的工作表；Sheet 名稱必須使用 QuestionTypeSchema 的題型代碼。",
      ),
    );
  } else if (rows.length === 0 && errors.length === 0) {
    errors.push(issue(null, null, null, "所有可匯入工作表都是空白。"));
  }

  const byCode = new Map<string, QuestionImportRow[]>();
  for (const row of rows) {
    const duplicates = byCode.get(row.input.code) ?? [];
    duplicates.push(row);
    byCode.set(row.input.code, duplicates);
  }
  for (const [code, duplicates] of byCode) {
    if (duplicates.length < 2) continue;
    for (const duplicate of duplicates) {
      errors.push(
        issue(
          duplicate.sheet,
          duplicate.row,
          code,
          `code「${code}」在匯入檔案中重複。`,
        ),
      );
    }
  }

  return { rows, errors };
};
