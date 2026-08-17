import type {
  AffairCollectionBinding,
  AffairSubmission,
  AffairSubmissionDetail,
  AffairSubmissionFieldValue,
  AffairSubmissionListQuery,
  AffairSubmissionWritePayload,
  BatchReturnAffairSubmissionsInput,
  EnsureAffairSubmissionInput,
  Page,
  SaveAffairSubmissionInput,
} from "@server-foundation/api-contracts";
import { DomainError, NotFoundError } from "../errors.js";
import type { AffairConfigurationRepository } from "../ports/affair-configuration-repository.js";
import type { AffairRepository } from "../ports/affair-repository.js";
import type { AffairSubmissionRepository } from "../ports/affair-submission-repository.js";
import type { QuestionBankScope } from "../ports/question-bank-repository.js";

const invalid = (message: string): never => {
  throw new DomainError("validation_error", message);
};

const patternMatches = (pattern: string, value: string): boolean => {
  try {
    let source = pattern;
    let flags = "u";
    const first = pattern[0];
    if (first && !/[A-Za-z0-9\\\s]/.test(first)) {
      const last = pattern.lastIndexOf(first);
      if (last > 0) {
        source = pattern.slice(1, last);
        const phpFlags = pattern.slice(last + 1);
        if (/[^imsu]/.test(phpFlags)) return false;
        flags = Array.from(new Set(`${phpFlags}u`)).join("");
      }
    }
    return new RegExp(source, flags).test(value);
  } catch {
    return false;
  }
};

const validateValue = (
  value: string,
  binding: AffairCollectionBinding,
  label: string,
): void => {
  if (binding.isRequired && value === "") invalid(`${label} is required.`);
  if (value === "") return;

  const field = binding.field;
  const rules = field.validation ?? {};
  if (field.dataType === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) invalid(`${label} must be a number.`);
    if (rules.min !== undefined && rules.min !== null && number < rules.min) {
      invalid(`${label} must not be less than ${rules.min}.`);
    }
    if (rules.max !== undefined && rules.max !== null && number > rules.max) {
      invalid(`${label} must not be greater than ${rules.max}.`);
    }
  }

  // PHP applies min/max length to every non-empty value, regardless of data_type.
  const length = Array.from(value).length;
  if (rules.min_length && length < rules.min_length) {
    invalid(`${label} is shorter than the configured minimum length.`);
  }
  if (rules.max_length && length > rules.max_length) {
    invalid(`${label} is longer than the configured maximum length.`);
  }

  if (field.dataType === "date") {
    if (rules.min_date && value < rules.min_date) {
      invalid(`${label} is earlier than the configured minimum date.`);
    }
    if (rules.max_date && value > rules.max_date) {
      invalid(`${label} is later than the configured maximum date.`);
    }
  }
  if (field.dataType === "time") {
    if (rules.min_time && value < rules.min_time) {
      invalid(`${label} is earlier than the configured minimum time.`);
    }
    if (rules.max_time && value > rules.max_time) {
      invalid(`${label} is later than the configured maximum time.`);
    }
  }
  // PHP does not re-check select_options at submission time; preserve that behavior.
  if (rules.pattern && !patternMatches(rules.pattern, value)) {
    invalid(rules.pattern_desc || `${label} has an invalid format.`);
  }
};

const mergedFormFields = (
  current: AffairSubmissionDetail,
  incoming: AffairSubmissionFieldValue[],
): AffairSubmissionFieldValue[] => {
  const merged = new Map<string, string>();
  if (current.payload.kind === "form") {
    for (const field of current.payload.fields) merged.set(field.fieldId, field.value);
  }
  for (const field of incoming) merged.set(field.fieldId, field.value);
  return Array.from(merged, ([fieldId, value]) => ({ fieldId, value }));
};

export class AffairSubmissionService {
  constructor(
    private readonly repository: AffairSubmissionRepository,
    private readonly affairs: AffairRepository,
    private readonly configurations: AffairConfigurationRepository,
  ) {}

  async listSubmissions(
    query: AffairSubmissionListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<AffairSubmission>> {
    const collection = await this.configurations.getCollection(
      query.collectionId,
      scope,
    );
    if (!collection) throw new NotFoundError("affair collection", query.collectionId);
    return this.repository.listSubmissions(query, scope);
  }

  async getSubmission(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const item = await this.repository.getSubmission(id, scope);
    if (!item) throw new NotFoundError("affair submission", id);
    return item;
  }

  async ensureSubmission(
    input: EnsureAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<{ created: boolean; item: AffairSubmission }> {
    const affair = await this.affairs.getAffair(input.affairId, scope);
    if (!affair) throw new NotFoundError("affair", input.affairId);
    const collection = await this.configurations.getCollection(
      input.collectionId,
      scope,
    );
    if (!collection || collection.affairId !== input.affairId) {
      throw new NotFoundError("affair collection", input.collectionId);
    }
    if (collection.type === "receipt") {
      invalid("Receipt collections do not use submission records in C wave.");
    }
    if (collection.target !== input.submitterType) {
      invalid("The collection target does not match the submitter type.");
    }

    if (input.submitterType === "school") {
      const school = await this.affairs.getSchool(input.schoolId, scope);
      if (!school || school.affairId !== input.affairId) {
        throw new NotFoundError("affair school", input.schoolId);
      }
    } else {
      const city = (await this.affairs.listCities(scope)).find(
        (candidate) => candidate.id === input.cityId,
      );
      if (!city) throw new NotFoundError("affair city", input.cityId);
    }

    return this.repository.ensureSubmission(input, scope);
  }

  async saveDraft(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const current = await this.getSubmission(id, scope);
    if (current.status === "submitted") {
      invalid("Submitted data cannot be modified.");
    }
    await this.validatePayload(current, input.payload, scope, false);
    return this.repository.saveDraft(id, input, scope);
  }

  async submit(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const current = await this.getSubmission(id, scope);
    if (current.status === "submitted") {
      invalid("The submission was already submitted.");
    }

    // PHP saves the submitted payload first and only then runs final validation.
    // A validation failure therefore keeps the new payload while status/version stay put.
    const staged = await this.repository.stageSubmitPayload(id, input, scope);
    await this.validatePayload(staged, input.payload, scope, true);
    return this.repository.submit(id, input, scope);
  }

  async returnSubmission(
    id: string,
    version: number,
    reason: string | null,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const current = await this.getSubmission(id, scope);
    if (current.status !== "submitted") {
      invalid("Only submitted data can be returned.");
    }
    return this.repository.returnSubmission(id, version, reason, scope);
  }

  async batchReturn(
    input: BatchReturnAffairSubmissionsInput,
    scope: QuestionBankScope,
  ): Promise<{ returned: number; skipped: number }> {
    let returned = 0;
    let skipped = 0;
    for (const item of input.items) {
      try {
        const current = await this.repository.getSubmission(item.id, scope);
        if (!current || current.status !== "submitted") {
          skipped++;
          continue;
        }
        await this.repository.returnSubmission(
          item.id,
          item.version,
          input.reason,
          scope,
        );
        returned++;
      } catch (error) {
        if (
          error instanceof DomainError &&
          (error.code === "not_found" ||
            error.code === "conflict" ||
            error.code === "validation_error")
        ) {
          skipped++;
          continue;
        }
        throw error;
      }
    }
    return { returned, skipped };
  }

  async deleteSubmission(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getSubmission(id, scope);
    await this.repository.deleteSubmission(id, version, scope);
  }

  private async validatePayload(
    current: AffairSubmissionDetail,
    payload: AffairSubmissionWritePayload,
    scope: QuestionBankScope,
    finalSubmit: boolean,
  ): Promise<void> {
    const collection = await this.configurations.getCollection(
      current.collectionId,
      scope,
    );
    if (!collection) {
      throw new NotFoundError("affair collection", current.collectionId);
    }
    if (collection.type === "receipt") {
      invalid("Receipt collections do not use form/excel submission payloads.");
    }
    if (payload.kind !== collection.type) {
      invalid("Submission payload kind does not match the collection type.");
    }

    const bindings = await this.configurations.listBindings(
      current.collectionId,
      scope,
    );
    const bindingById = new Map(
      bindings.map((binding) => [binding.fieldId, binding]),
    );

    if (payload.kind === "form") {
      const incomingIds = payload.fields.map((field) => field.fieldId);
      if (new Set(incomingIds).size !== incomingIds.length) {
        invalid("A form field may appear only once in a save payload.");
      }
      for (const field of payload.fields) {
        if (!bindingById.has(field.fieldId)) {
          invalid(
            "Submission data contains a field that is not bound to this collection.",
          );
        }
      }
      if (finalSubmit) {
        const values = new Map(
          mergedFormFields(current, payload.fields).map((field) => [
            field.fieldId,
            field.value.trim(),
          ]),
        );
        for (const binding of bindings) {
          validateValue(
            values.get(binding.fieldId) ?? "",
            binding,
            binding.field.name,
          );
        }
      }
      return;
    }

    for (const [rowIndex, row] of payload.rows.entries()) {
      for (const fieldId of Object.keys(row.values)) {
        if (!bindingById.has(fieldId)) {
          invalid(
            `Row ${rowIndex + 1} contains a field that is not bound to this collection.`,
          );
        }
      }
    }
    if (finalSubmit) {
      if (payload.rows.length === 0) invalid("At least one row is required.");
      for (const [rowIndex, row] of payload.rows.entries()) {
        for (const binding of bindings) {
          validateValue(
            (row.values[binding.fieldId] ?? "").trim(),
            binding,
            `Row ${rowIndex + 1} ${binding.field.name}`,
          );
        }
      }
    }
  }
}
