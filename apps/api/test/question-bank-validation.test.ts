import { describe, expect, it } from "vitest";
import {
  DomainError,
  validateKnownQuestionShape,
} from "@server-foundation/domain";
import type {
  Question,
  QuestionType,
} from "@server-foundation/api-contracts";

type Shape = Pick<Question, "type" | "stem" | "options" | "answer">;

const shape = (
  type: QuestionType,
  answer: Shape["answer"],
  options: Shape["options"] = null,
  stem = "Question stem",
): Shape => ({ type, stem, options, answer });

const expectValid = (question: Shape): void => {
  expect(() => validateKnownQuestionShape(question)).not.toThrow();
};

const expectInvalid = (question: Shape, fragment: string): void => {
  try {
    validateKnownQuestionShape(question);
    throw new Error("Expected validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as Error).message).toContain(fragment);
  }
};

const options = [
  { id: "a", text: "Alpha" },
  { id: "b", text: "Beta" },
];

describe("question bank PHP validation parity", () => {
  it("validates short_answer including PHP empty semantics", () => {
    expectValid(
      shape("short_answer", {
        sample_answer: "Example",
        match_mode: "manual",
      }),
    );
    expectValid(
      shape("short_answer", { keywords: ["key"], match_mode: "all" }),
    );
    expectInvalid(
      shape("short_answer", { sample_answer: "0", keywords: [] }),
      "sample answer or keywords",
    );
    expectInvalid(
      shape("short_answer", { sample_answer: "Example", match_mode: "some" }),
      "match_mode is invalid",
    );
  });

  it("validates matching", () => {
    const validAnswer = {
      right_items: ["One", "Two"],
      pairs: [
        { left: "a", right: "One" },
        { left: "b", right: "Two" },
      ],
    };
    expectValid(shape("matching", validAnswer, options));
    expectInvalid(
      shape("matching", validAnswer, [options[0]!]),
      "two left-side",
    );
    expectInvalid(
      shape("matching", validAnswer, [options[0]!, { id: "b", text: "0" }]),
      "cannot be empty",
    );
    expectInvalid(
      shape("matching", { ...validAnswer, right_items: ["One"] }, options),
      "two right-side",
    );
    expectInvalid(
      shape("matching", { ...validAnswer, right_items: ["One", "0"] }, options),
      "right-side item 2",
    );
    expectInvalid(
      shape(
        "matching",
        { ...validAnswer, pairs: [{ left: "a", right: "One" }] },
        options,
      ),
      "two pairs",
    );
    expectInvalid(
      shape(
        "matching",
        {
          ...validAnswer,
          pairs: [
            { left: "missing", right: "One" },
            { left: "b", right: "Two" },
          ],
        },
        options,
      ),
      "invalid left-side",
    );
    expectInvalid(
      shape(
        "matching",
        {
          ...validAnswer,
          pairs: [
            { left: "a", right: "missing" },
            { left: "b", right: "Two" },
          ],
        },
        options,
      ),
      "invalid right-side",
    );
  });

  it("validates sorting and preserves the PHP duplicate-order behavior", () => {
    expectValid(shape("sorting", { order: ["b", "a"] }, options));
    expectInvalid(shape("sorting", {}, options), "correct order array");
    expectInvalid(
      shape("sorting", { order: ["a"] }, options),
      "count must match",
    );
    expectInvalid(
      shape("sorting", { order: ["a", "missing"] }, options),
      "invalid item",
    );
    expectValid(shape("sorting", { order: ["a", "a"] }, options));
  });

  it("validates fill_blank markers, counts, non-empty answers, and mode", () => {
    expectValid(
      shape(
        "fill_blank",
        { blanks: ["1", "2"], mode: "exact" },
        null,
        "___ + ___",
      ),
    );
    expectInvalid(shape("fill_blank", { blanks: ["1"] }), "___ marker");
    expectInvalid(
      shape("fill_blank", {}, null, "___"),
      "blanks answer array",
    );
    expectInvalid(
      shape("fill_blank", { blanks: ["1"] }, null, "___ + ___"),
      "answer count",
    );
    expectInvalid(
      shape("fill_blank", { blanks: ["0"] }, null, "___"),
      "answer 1 cannot be empty",
    );
    expectInvalid(
      shape("fill_blank", { blanks: ["1"], mode: "regex" }, null, "___"),
      "mode is invalid",
    );
  });

  it("validates dropdown blank configuration", () => {
    const valid = { blanks: [{ options: ["A", "B"], correct: 0 }] };
    expectValid(shape("dropdown", valid, null, "Choose ___"));
    expectInvalid(shape("dropdown", valid), "___ marker");
    expectInvalid(
      shape("dropdown", {}, null, "___"),
      "configuration array",
    );
    expectInvalid(
      shape("dropdown", { blanks: [] }, null, "___"),
      "blank count",
    );
    expectInvalid(
      shape(
        "dropdown",
        { blanks: [{ options: ["A"], correct: 0 }] },
        null,
        "___",
      ),
      "two options",
    );
    expectInvalid(
      shape(
        "dropdown",
        { blanks: [{ options: ["A", "0"], correct: 0 }] },
        null,
        "___",
      ),
      "option 2 cannot be empty",
    );
    expectInvalid(
      shape(
        "dropdown",
        { blanks: [{ options: ["A", "B"] }] },
        null,
        "___",
      ),
      "integer correct index",
    );
    expectInvalid(
      shape(
        "dropdown",
        { blanks: [{ options: ["A", "B"], correct: 2 }] },
        null,
        "___",
      ),
      "correct index is invalid",
    );
  });

  it("validates choice_short_answer", () => {
    const valid = {
      choices: ["Yes", "No"],
      rows: [
        { option_id: "a", choice: 0 },
        { option_id: "b", choice: 1 },
      ],
    };
    expectValid(shape("choice_short_answer", valid, options));
    expectInvalid(
      shape("choice_short_answer", valid, [options[0]!]),
      "two items",
    );
    expectInvalid(
      shape(
        "choice_short_answer",
        valid,
        [options[0]!, { id: "b", text: "0" }],
      ),
      "item 2 cannot be empty",
    );
    expectInvalid(
      shape("choice_short_answer", { ...valid, choices: ["Yes"] }, options),
      "two choice columns",
    );
    expectInvalid(
      shape(
        "choice_short_answer",
        { ...valid, choices: ["Yes", "0"] },
        options,
      ),
      "choice 2 cannot be empty",
    );
    expectInvalid(
      shape("choice_short_answer", { choices: ["Yes", "No"] }, options),
      "answer rows",
    );
    expectInvalid(
      shape(
        "choice_short_answer",
        { ...valid, rows: [{ option_id: "a", choice: 0 }] },
        options,
      ),
      "row count",
    );
    expectInvalid(
      shape(
        "choice_short_answer",
        {
          ...valid,
          rows: [
            { option_id: "missing", choice: 0 },
            { option_id: "b", choice: 1 },
          ],
        },
        options,
      ),
      "invalid item id",
    );
    expectInvalid(
      shape(
        "choice_short_answer",
        {
          ...valid,
          rows: [
            { option_id: "a", choice: "0" },
            { option_id: "b", choice: 1 },
          ],
        },
        options,
      ),
      "integer choice index",
    );
    expectInvalid(
      shape(
        "choice_short_answer",
        {
          ...valid,
          rows: [
            { option_id: "a", choice: 2 },
            { option_id: "b", choice: 1 },
          ],
        },
        options,
      ),
      "choice index is invalid",
    );
  });

  it("validates math including PHP empty('0') semantics", () => {
    expectValid(shape("math", { latex: "x=1" }));
    expectValid(shape("math", { latex: "x=1", scoring: "equivalent" }));
    expectInvalid(shape("math", { latex: "0" }), "non-empty latex");
    expectInvalid(shape("math", { latex: "   " }), "non-empty latex");
    expectInvalid(
      shape("math", { latex: "x=1", scoring: "manual" }),
      "scoring mode",
    );
  });

  it("validates drawing while preserving the source's missing background-or-element gate", () => {
    const board = { xMin: -10, xMax: 10, yMin: -5, yMax: 5 };
    expectValid(shape("drawing", { board }));
    expectInvalid(shape("drawing", {}), "board bounds");
    expectInvalid(
      shape("drawing", { board: { xMin: 0, xMax: 1, yMin: 0 } }),
      "incomplete",
    );
    expectInvalid(
      shape("drawing", { board: { ...board, xMin: 10 } }),
      "xMin",
    );
    expectInvalid(
      shape("drawing", { board: { ...board, yMin: 5 } }),
      "yMin",
    );
    expectInvalid(
      shape(
        "drawing",
        {
          board,
          backgroundImage: { url: "", position: [0, 0], size: [1, 1] },
        },
      ),
      "URL is invalid",
    );
    expectInvalid(
      shape(
        "drawing",
        {
          board,
          backgroundImage: {
            url: "image.png",
            position: [0],
            size: [1, 1],
          },
        },
      ),
      "position is invalid",
    );
    expectInvalid(
      shape(
        "drawing",
        {
          board,
          backgroundImage: {
            url: "image.png",
            position: [0, 0],
            size: [1],
          },
        },
      ),
      "size is invalid",
    );
    expectInvalid(
      shape(
        "drawing",
        {
          board,
          backgroundImage: {
            url: "image.png",
            position: [0, 0],
            size: [1, 0],
          },
        },
      ),
      "size must be positive",
    );
    expectInvalid(
      shape("drawing", {
        board,
        referenceGraph: { elements: [{ type: "text", content: "0" }] },
      }),
      "text element 1",
    );
  });

  it("validates development_drawing chart axes and lines", () => {
    const chart = {
      xAxis: { enabled: true, name: "X", min: 0, max: 10, interval: 1 },
      yAxis: { enabled: true, name: "Y", min: -5, max: 5, interval: 1 },
    };
    const lines = [{ name: "Line A", points: [[0, 0], [1, 1]] }];
    expectValid(shape("development_drawing", { chart, lines }));
    expectInvalid(shape("development_drawing", { lines }), "chart settings");
    expectInvalid(
      shape(
        "development_drawing",
        {
          chart: { ...chart, xAxis: { ...chart.xAxis, name: "0" } },
          lines,
        },
      ),
      "X axis requires a name",
    );
    expectInvalid(
      shape(
        "development_drawing",
        {
          chart: {
            ...chart,
            xAxis: { enabled: true, name: "X", min: 0, max: 10 },
          },
          lines,
        },
      ),
      "X axis settings are incomplete",
    );
    expectInvalid(
      shape(
        "development_drawing",
        {
          chart: { ...chart, xAxis: { ...chart.xAxis, min: 10 } },
          lines,
        },
      ),
      "X axis min",
    );
    expectInvalid(
      shape(
        "development_drawing",
        {
          chart: { ...chart, xAxis: { ...chart.xAxis, interval: 0 } },
          lines,
        },
      ),
      "X axis interval",
    );
    expectInvalid(
      shape(
        "development_drawing",
        {
          chart: { ...chart, yAxis: { ...chart.yAxis, max: -5 } },
          lines,
        },
      ),
      "Y axis min",
    );
    expectInvalid(
      shape("development_drawing", { chart, lines: [] }),
      "at least one line",
    );
    expectInvalid(
      shape("development_drawing", {
        chart,
        lines: Array.from({ length: 11 }, (_, index) => ({
          name: `L${index}`,
          points: [[0, 0], [1, 1]],
        })),
      }),
      "at most ten lines",
    );
    expectInvalid(
      shape("development_drawing", {
        chart,
        lines: [{ name: "0", points: [[0, 0], [1, 1]] }],
      }),
      "requires a name",
    );
    expectInvalid(
      shape("development_drawing", {
        chart,
        lines: [
          { name: "Same", points: [[0, 0], [1, 1]] },
          { name: "Same", points: [[2, 2], [3, 3]] },
        ],
      }),
      "duplicated",
    );
    expectInvalid(
      shape("development_drawing", {
        chart,
        lines: [{ name: "Line A", points: [[0, 0]] }],
      }),
      "two points",
    );
    expectInvalid(
      shape("development_drawing", {
        chart,
        lines: [{ name: "Line A", points: [[0, 0], [1]] }],
      }),
      "point 2 is invalid",
    );
  });

  it("validates interactive field names and duplicates", () => {
    expectValid(shape("interactive", {}));
    expectValid(
      shape("interactive", { fields: ["", "answer_1", "_score"] }),
    );
    expectInvalid(
      shape("interactive", { fields: ["bad-name"] }),
      "field name bad-name is invalid",
    );
    expectInvalid(
      shape("interactive", { fields: ["same", "same"] }),
      "field name same is duplicated",
    );
  });

  it("validates drag_drop including PHP reusable truthiness", () => {
    const valid = { blanks: ["a", "b"] };
    expectValid(shape("drag_drop", valid, options, "___ then ___"));
    expectInvalid(shape("drag_drop", valid, options), "___ marker");
    expectInvalid(
      shape("drag_drop", valid, [options[0]!], "___ then ___"),
      "two options",
    );
    expectInvalid(
      shape(
        "drag_drop",
        valid,
        [options[0]!, { id: "b", text: "0" }],
        "___ then ___",
      ),
      "cannot be empty",
    );
    expectInvalid(
      shape(
        "drag_drop",
        valid,
        [options[0]!, { id: "b", text: " Alpha " }],
        "___ then ___",
      ),
      "text must be unique",
    );
    expectInvalid(
      shape("drag_drop", {}, options, "___ then ___"),
      "blanks answer array",
    );
    expectInvalid(
      shape("drag_drop", { blanks: ["a"] }, options, "___ then ___"),
      "answer count",
    );
    expectInvalid(
      shape(
        "drag_drop",
        { blanks: ["a", "missing"] },
        options,
        "___ then ___",
      ),
      "invalid option",
    );
    expectInvalid(
      shape(
        "drag_drop",
        { blanks: ["a", "a"], reusable: false },
        options,
        "___ then ___",
      ),
      "reused while reusable is disabled",
    );
    expectValid(
      shape(
        "drag_drop",
        { blanks: ["a", "a"], reusable: true },
        options,
        "___ then ___",
      ),
    );
    expectValid(
      shape(
        "drag_drop",
        { blanks: ["a", "a"], reusable: "false" },
        options,
        "___ then ___",
      ),
    );
  });
});
