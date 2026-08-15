import type {
  CreateQuestionCategoryInput,
  CreateQuestionInput,
  Page,
  Question,
  QuestionCategory,
  QuestionCategoryListQuery,
  QuestionListQuery,
  UpdateQuestionCategoryInput,
  UpdateQuestionInput,
} from "@server-foundation/api-contracts";
import { DomainError, NotFoundError } from "../errors.js";
import type {
  QuestionBankRepository,
  QuestionBankScope,
} from "../ports/question-bank-repository.js";

type JsonObject = Record<string, unknown>;

const jsonObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const optionRows = (value: unknown): JsonObject[] | null =>
  Array.isArray(value) && value.every((entry) => jsonObject(entry) !== null)
    ? (value as JsonObject[])
    : null;

const validationError: (message: string) => never = (message: string) => {
  throw new DomainError("validation_error", message);
};

const phpEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") return value === "" || value === "0";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
};

const phpTrim = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value).trim();
  }
  return "";
};

const phpFloat = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return 0;
  const match = value
    .trimStart()
    .match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
  return match ? Number(match[0]) : 0;
};

const isSet = (object: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key) &&
  object[key] !== null &&
  object[key] !== undefined;

const strictIncludes = (values: unknown[], value: unknown): boolean =>
  values.some((candidate) => candidate === value);

const arrayColumnIds = (rows: JsonObject[]): unknown[] =>
  rows
    .filter((row) => Object.prototype.hasOwnProperty.call(row, "id"))
    .map((row) => row.id);

const countBlanks = (stem: string): number => stem.split("___").length - 1;

const validateChoiceOptions = (options: unknown): JsonObject[] => {
  const rows = optionRows(options);
  if (!rows || rows.length < 2) {
    return validationError("Choice questions require at least two options.");
  }
  const ids = new Set<string>();
  for (const option of rows) {
    const id = option.id;
    const text = option.text;
    if (typeof id !== "string" || !id.trim()) {
      return validationError("Every choice option requires a non-empty id.");
    }
    if (typeof text !== "string" || !text.trim()) {
      return validationError("Every choice option requires non-empty text.");
    }
    if (ids.has(id))
      return validationError("Choice option ids must be unique.");
    ids.add(id);
  }
  return rows;
};

const requireRowsWithText = (
  options: unknown,
  minimumMessage: string,
  emptyMessage: (position: number, id: unknown) => string,
): JsonObject[] => {
  const rows = optionRows(options);
  if (!rows || rows.length < 2) validationError(minimumMessage);
  for (const [index, option] of rows.entries()) {
    if (phpEmpty(phpTrim(option.text))) {
      validationError(emptyMessage(index + 1, option.id));
    }
  }
  return rows;
};

export const validateKnownQuestionShape = (
  question: Pick<Question, "type" | "stem" | "options" | "answer">,
): void => {
  const answer = jsonObject(question.answer);
  if (!answer) validationError("Question answer must be a JSON object.");

  if (question.type === "true_false") {
    const value = answer.value;
    if (typeof value !== "boolean" && value !== "true" && value !== "false") {
      validationError(
        "true_false answer.value must be boolean true/false or the strings 'true'/'false'.",
      );
    }
    return;
  }

  if (question.type === "single_choice") {
    const options = validateChoiceOptions(question.options);
    const ids = new Set(options.map((option) => String(option.id)));
    if (typeof answer.value !== "string" || !ids.has(answer.value)) {
      validationError(
        "single_choice answer.value must reference an option id.",
      );
    }
    return;
  }

  if (question.type === "multiple_choice") {
    const options = validateChoiceOptions(question.options);
    const ids = new Set(options.map((option) => String(option.id)));
    if (
      !Array.isArray(answer.values) ||
      answer.values.length < 1 ||
      !answer.values.every(
        (value) => typeof value === "string" && ids.has(value),
      )
    ) {
      validationError(
        "multiple_choice answer.values must contain at least one valid option id.",
      );
    }
    return;
  }

  if (question.type === "short_answer") {
    if (phpEmpty(answer.sample_answer) && phpEmpty(answer.keywords)) {
      validationError("short_answer requires a sample answer or keywords.");
    }
    if (
      !phpEmpty(answer.match_mode) &&
      answer.match_mode !== "any" &&
      answer.match_mode !== "all" &&
      answer.match_mode !== "manual"
    ) {
      validationError("short_answer match_mode is invalid.");
    }
    return;
  }

  if (question.type === "matching") {
    const options = requireRowsWithText(
      question.options,
      "matching requires at least two left-side items.",
      (position, id) =>
        `matching left-side item ${String(id ?? position)} cannot be empty.`,
    );
    if (!Array.isArray(answer.right_items) || answer.right_items.length < 2) {
      validationError("matching requires at least two right-side items.");
    }
    for (const [index, item] of answer.right_items.entries()) {
      if (phpEmpty(phpTrim(item))) {
        validationError(`matching right-side item ${index + 1} cannot be empty.`);
      }
    }
    if (!Array.isArray(answer.pairs) || answer.pairs.length < 2) {
      validationError("matching requires at least two pairs.");
    }
    const leftIds = arrayColumnIds(options);
    for (const pairValue of answer.pairs) {
      const pair = jsonObject(pairValue);
      if (!pair || !strictIncludes(leftIds, pair.left ?? "")) {
        validationError("matching pair references an invalid left-side item.");
      }
      if (!strictIncludes(answer.right_items, pair.right ?? "")) {
        validationError("matching pair references an invalid right-side item.");
      }
    }
    return;
  }

  if (question.type === "sorting") {
    const options = requireRowsWithText(
      question.options,
      "sorting requires at least two items.",
      (position, id) =>
        `sorting item ${String(id ?? position)} cannot be empty.`,
    );
    if (!Array.isArray(answer.order)) {
      validationError("sorting requires a correct order array.");
    }
    const validIds = arrayColumnIds(options);
    if (answer.order.length !== validIds.length) {
      validationError("sorting order count must match the item count.");
    }
    for (const id of answer.order) {
      if (!strictIncludes(validIds, id)) {
        validationError("sorting order contains an invalid item.");
      }
    }
    return;
  }

  if (question.type === "fill_blank") {
    const blankCount = countBlanks(question.stem);
    if (blankCount < 1) {
      validationError("fill_blank stem must contain at least one ___ marker.");
    }
    if (!Array.isArray(answer.blanks)) {
      validationError("fill_blank requires a blanks answer array.");
    }
    if (answer.blanks.length !== blankCount) {
      validationError("fill_blank answer count must match the ___ marker count.");
    }
    for (const [index, blank] of answer.blanks.entries()) {
      if (phpEmpty(phpTrim(blank))) {
        validationError(`fill_blank answer ${index + 1} cannot be empty.`);
      }
    }
    if (
      !phpEmpty(answer.mode) &&
      answer.mode !== "exact" &&
      answer.mode !== "contains"
    ) {
      validationError("fill_blank mode is invalid.");
    }
    return;
  }

  if (question.type === "dropdown") {
    const blankCount = countBlanks(question.stem);
    if (blankCount < 1) {
      validationError("dropdown stem must contain at least one ___ marker.");
    }
    if (!Array.isArray(answer.blanks)) {
      validationError("dropdown requires a blanks configuration array.");
    }
    if (answer.blanks.length !== blankCount) {
      validationError("dropdown blank count must match the ___ marker count.");
    }
    for (const [index, blankValue] of answer.blanks.entries()) {
      const blank = jsonObject(blankValue);
      if (!blank || !Array.isArray(blank.options) || blank.options.length < 2) {
        validationError(`dropdown blank ${index + 1} requires at least two options.`);
      }
      for (const [optionIndex, optionText] of blank.options.entries()) {
        if (phpEmpty(phpTrim(optionText))) {
          validationError(
            `dropdown blank ${index + 1} option ${optionIndex + 1} cannot be empty.`,
          );
        }
      }
      if (!isSet(blank, "correct") || !Number.isInteger(blank.correct)) {
        validationError(
          `dropdown blank ${index + 1} requires an integer correct index.`,
        );
      }
      const correct = blank.correct as number;
      if (correct < 0 || correct >= blank.options.length) {
        validationError(`dropdown blank ${index + 1} correct index is invalid.`);
      }
    }
    return;
  }

  if (question.type === "choice_short_answer") {
    const options = requireRowsWithText(
      question.options,
      "choice_short_answer requires at least two items.",
      (position) => `choice_short_answer item ${position} cannot be empty.`,
    );
    if (!Array.isArray(answer.choices) || answer.choices.length < 2) {
      validationError(
        "choice_short_answer requires at least two choice columns.",
      );
    }
    for (const [index, choice] of answer.choices.entries()) {
      if (phpEmpty(phpTrim(choice))) {
        validationError(
          `choice_short_answer choice ${index + 1} cannot be empty.`,
        );
      }
    }
    if (!Array.isArray(answer.rows)) {
      validationError("choice_short_answer requires answer rows.");
    }
    if (answer.rows.length !== options.length) {
      validationError(
        "choice_short_answer row count must match the item count.",
      );
    }
    const validOptionIds = arrayColumnIds(options);
    for (const [index, rowValue] of answer.rows.entries()) {
      const row = jsonObject(rowValue);
      if (
        !row ||
        !isSet(row, "option_id") ||
        !strictIncludes(validOptionIds, row.option_id)
      ) {
        validationError(
          `choice_short_answer row ${index + 1} has an invalid item id.`,
        );
      }
      if (!isSet(row, "choice") || !Number.isInteger(row.choice)) {
        validationError(
          `choice_short_answer row ${index + 1} requires an integer choice index.`,
        );
      }
      const choice = row.choice as number;
      if (choice < 0 || choice >= answer.choices.length) {
        validationError(
          `choice_short_answer row ${index + 1} choice index is invalid.`,
        );
      }
    }
    return;
  }

  if (question.type === "math") {
    if (
      phpEmpty(answer.latex) ||
      typeof answer.latex !== "string" ||
      answer.latex.trim() === ""
    ) {
      validationError("math requires a non-empty latex answer.");
    }
    const scoring = answer.scoring ?? "exact";
    if (scoring !== "exact" && scoring !== "equivalent") {
      validationError("math scoring mode is invalid.");
    }
    return;
  }

  if (question.type === "drawing") {
    const board = jsonObject(answer.board);
    if (!board) validationError("drawing requires board bounds.");
    if (
      !isSet(board, "xMin") ||
      !isSet(board, "xMax") ||
      !isSet(board, "yMin") ||
      !isSet(board, "yMax")
    ) {
      validationError("drawing board bounds are incomplete.");
    }
    if (phpFloat(board.xMin) >= phpFloat(board.xMax)) {
      validationError("drawing xMin must be less than xMax.");
    }
    if (phpFloat(board.yMin) >= phpFloat(board.yMax)) {
      validationError("drawing yMin must be less than yMax.");
    }

    if (!phpEmpty(answer.backgroundImage)) {
      const background = jsonObject(answer.backgroundImage);
      if (
        !background ||
        phpEmpty(background.url) ||
        typeof background.url !== "string"
      ) {
        validationError("drawing background image URL is invalid.");
      }
      if (
        !Array.isArray(background.position) ||
        background.position.length < 2
      ) {
        validationError("drawing background image position is invalid.");
      }
      if (!Array.isArray(background.size) || background.size.length < 2) {
        validationError("drawing background image size is invalid.");
      }
      if (
        phpFloat(background.size[0]) <= 0 ||
        phpFloat(background.size[1]) <= 0
      ) {
        validationError("drawing background image size must be positive.");
      }
    }

    const referenceGraph = jsonObject(answer.referenceGraph);
    const elements = referenceGraph?.elements;
    if (Array.isArray(elements) && elements.length > 0) {
      for (const [index, elementValue] of elements.entries()) {
        const element = jsonObject(elementValue);
        if (element?.type === "text" && phpEmpty(phpTrim(element.content))) {
          validationError(`drawing text element ${index + 1} cannot be empty.`);
        }
      }
    }
    return;
  }

  if (question.type === "drag_drop") {
    const blankCount = countBlanks(question.stem);
    if (blankCount < 1) {
      validationError("drag_drop stem must contain at least one ___ marker.");
    }
    const options = requireRowsWithText(
      question.options,
      "drag_drop requires at least two options.",
      (position, id) =>
        `drag_drop option ${String(id ?? position)} cannot be empty.`,
    );
    const optionTexts = options.map((option) => phpTrim(option.text));
    if (new Set(optionTexts).size !== optionTexts.length) {
      validationError("drag_drop option text must be unique.");
    }
    if (!Array.isArray(answer.blanks)) {
      validationError("drag_drop requires a blanks answer array.");
    }
    if (answer.blanks.length !== blankCount) {
      validationError(
        "drag_drop answer count must match the ___ marker count.",
      );
    }
    const validOptionIds = arrayColumnIds(options);
    for (const [index, id] of answer.blanks.entries()) {
      if (!strictIncludes(validOptionIds, id)) {
        validationError(
          `drag_drop blank ${index + 1} references an invalid option.`,
        );
      }
    }
    const reusable = !phpEmpty(answer.reusable);
    if (!reusable) {
      const used: unknown[] = [];
      for (const id of answer.blanks) {
        if (strictIncludes(used, id)) {
          validationError(
            `drag_drop option ${String(id)} is reused while reusable is disabled.`,
          );
        }
        used.push(id);
      }
    }
    return;
  }

  if (question.type === "development_drawing") {
    const chart = jsonObject(answer.chart);
    if (!chart) {
      validationError("development_drawing requires chart settings.");
    }

    const validateAxis = (key: "xAxis" | "yAxis", label: string): void => {
      const axis = jsonObject(chart[key]);
      if (!axis || phpEmpty(axis.enabled)) return;
      if (phpEmpty(phpTrim(axis.name))) {
        validationError(
          `development_drawing ${label} axis requires a name.`,
        );
      }
      if (
        !isSet(axis, "min") ||
        !isSet(axis, "max") ||
        !isSet(axis, "interval")
      ) {
        validationError(
          `development_drawing ${label} axis settings are incomplete.`,
        );
      }
      if (phpFloat(axis.min) >= phpFloat(axis.max)) {
        validationError(
          `development_drawing ${label} axis min must be less than max.`,
        );
      }
      if (phpFloat(axis.interval) <= 0) {
        validationError(
          `development_drawing ${label} axis interval must be positive.`,
        );
      }
    };

    validateAxis("xAxis", "X");
    validateAxis("yAxis", "Y");

    if (!Array.isArray(answer.lines) || answer.lines.length < 1) {
      validationError("development_drawing requires at least one line.");
    }
    if (answer.lines.length > 10) {
      validationError("development_drawing allows at most ten lines.");
    }
    const lineNames: string[] = [];
    for (const [lineIndex, lineValue] of answer.lines.entries()) {
      const line = jsonObject(lineValue);
      const name = phpTrim(line?.name);
      if (!line || phpEmpty(name)) {
        validationError(
          `development_drawing line ${lineIndex + 1} requires a name.`,
        );
      }
      if (lineNames.includes(name)) {
        validationError(
          `development_drawing line name ${name} is duplicated.`,
        );
      }
      lineNames.push(name);
      if (!Array.isArray(line.points) || line.points.length < 2) {
        validationError(
          `development_drawing line ${name} requires at least two points.`,
        );
      }
      for (const [pointIndex, point] of line.points.entries()) {
        if (!Array.isArray(point) || point.length < 2) {
          validationError(
            `development_drawing line ${name} point ${pointIndex + 1} is invalid.`,
          );
        }
      }
    }
    return;
  }

  if (question.type === "interactive") {
    if (Array.isArray(answer.fields)) {
      const fieldNames: string[] = [];
      for (const field of answer.fields) {
        const name = phpTrim(field);
        if (name === "") continue;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
          validationError(`interactive field name ${name} is invalid.`);
        }
        if (fieldNames.includes(name)) {
          validationError(`interactive field name ${name} is duplicated.`);
        }
        fieldNames.push(name);
      }
    }
  }
};

export class QuestionBankService {
  constructor(private readonly repository: QuestionBankRepository) {}

  listQuestions(
    query: QuestionListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Question>> {
    return this.repository.listQuestions(query, scope);
  }

  async getQuestion(id: string, scope: QuestionBankScope): Promise<Question> {
    const question = await this.repository.getQuestion(id, scope);
    if (!question) throw new NotFoundError("question", id);
    return question;
  }

  createQuestion(
    input: CreateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question> {
    validateKnownQuestionShape({
      type: input.type,
      stem: input.stem,
      options: input.options,
      answer: input.answer,
    });
    return this.repository.createQuestion(input, scope);
  }

  async updateQuestion(
    id: string,
    input: UpdateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question> {
    const current = await this.getQuestion(id, scope);
    validateKnownQuestionShape({
      type: input.type ?? current.type,
      stem: input.stem ?? current.stem,
      options: input.options === undefined ? current.options : input.options,
      answer: input.answer === undefined ? current.answer : input.answer,
    });
    return this.repository.updateQuestion(id, input, scope);
  }

  async softDeleteQuestion(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getQuestion(id, scope);
    await this.repository.softDeleteQuestion(id, version, scope);
  }

  listCategories(
    query: QuestionCategoryListQuery,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory[]> {
    return this.repository.listCategories(query, scope);
  }

  async getCategory(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    const category = await this.repository.getCategory(id, scope);
    if (!category) throw new NotFoundError("question category", id);
    return category;
  }

  createCategory(
    input: CreateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    return this.repository.createCategory(input, scope);
  }

  async updateCategory(
    id: string,
    input: UpdateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    await this.getCategory(id, scope);
    return this.repository.updateCategory(id, input, scope);
  }

  async softDeleteCategory(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getCategory(id, scope);
    await this.repository.softDeleteCategory(id, version, scope);
  }
}
