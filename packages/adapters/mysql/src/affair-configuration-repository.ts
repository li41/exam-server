import { randomUUID } from "node:crypto";
import {
  AffairCollectionSettingsSchema,
  AffairExcelFieldValidationSchema,
  AffairReferenceRowDataSchema,
  AffairSelectOptionsSchema,
} from "@server-foundation/api-contracts";
import type {
  AffairCollection,
  AffairCollectionBinding,
  AffairCollectionListQuery,
  AffairExcelField,
  AffairReferenceDataRow,
  CreateAffairCollectionInput,
  CreateAffairExcelFieldInput,
  ReplaceAffairCollectionBindingsInput,
  ReplaceAffairReferenceDataInput,
  UpdateAffairCollectionInput,
  UpdateAffairExcelFieldInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  AffairConfigurationRepository,
  QuestionBankScope,
} from "@server-foundation/domain";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { withTransaction } from "./transaction.js";

type Executor = Pick<Pool | PoolConnection, "execute">;
type SqlValue = string | number | Date | null;

type CollectionRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  affair_id: string;
  name: string;
  type: AffairCollection["type"];
  target: AffairCollection["target"];
  sort_order: number;
  status: AffairCollection["status"];
  settings: unknown;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type FieldRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  data_type: AffairExcelField["dataType"];
  is_required: number;
  validation: unknown;
  select_options: unknown;
  sort_order: number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type BindingRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  collection_id: string;
  field_id: string;
  is_required: number;
  sort_order: number;
  field_name: string;
  field_description: string | null;
  field_data_type: AffairExcelField["dataType"];
  field_is_required: number;
  field_validation: unknown;
  field_select_options: unknown;
  field_sort_order: number;
  field_version: number;
  field_created_at: Date | string;
  field_updated_at: Date | string;
};

type RefRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  collection_id: string;
  row_data: unknown;
  sort_order: number;
  created_at: Date | string;
};

type VersionRow = RowDataPacket & { version: number };
type IdRow = RowDataPacket & { id: string };
type CountRow = RowDataPacket & { count: number };
type SortRow = RowDataPacket & { max_sort: number };

const collectionColumns = `
  c.id, c.tenant_id, c.affair_id, c.name, c.type, c.target,
  c.sort_order, c.status, c.settings, c.version, c.created_at, c.updated_at`;

const fieldColumns = `
  f.id, f.tenant_id, f.name, f.description, f.data_type, f.is_required,
  f.validation, f.select_options, f.sort_order, f.version,
  f.created_at, f.updated_at`;

const bindingColumns = `
  b.id, b.tenant_id, b.collection_id, b.field_id, b.is_required, b.sort_order,
  f.name AS field_name, f.description AS field_description,
  f.data_type AS field_data_type, f.is_required AS field_is_required,
  f.validation AS field_validation, f.select_options AS field_select_options,
  f.sort_order AS field_sort_order, f.version AS field_version,
  f.created_at AS field_created_at, f.updated_at AS field_updated_at`;

const toIso = (value: Date | string): string => {
  const date =
    value instanceof Date
      ? value
      : new Date(
          /[zZ]|[+-]\d\d:?\d\d$/.test(value)
            ? value.replace(" ", "T")
            : `${value.replace(" ", "T")}Z`,
        );
  if (Number.isNaN(date.getTime())) {
    throw new Error("MySQL returned an invalid affair configuration date.");
  }
  return date.toISOString();
};

const parseJson = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("MySQL returned invalid affair configuration JSON.");
  }
};

const encodeJson = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

const isDuplicateEntry = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ER_DUP_ENTRY";

const validationError = (message: string): never => {
  throw new DomainError("validation_error", message);
};

export class MySqlAffairConfigurationRepository implements AffairConfigurationRepository {
  constructor(private readonly pool: Pool) {}

  async listCollections(
    query: AffairCollectionListQuery,
    scope: QuestionBankScope,
  ): Promise<AffairCollection[]> {
    await this.assertAffair(this.pool, query.affairId, scope);
    const predicates = ["c.tenant_id = ?", "c.affair_id = ?"];
    const params: SqlValue[] = [scope.tenantId, query.affairId];
    if (query.type) {
      predicates.push("c.type = ?");
      params.push(query.type);
    }
    if (query.target) {
      predicates.push("c.target = ?");
      params.push(query.target);
    }
    if (query.status) {
      predicates.push("c.status = ?");
      params.push(query.status);
    }
    const [rows] = await this.pool.execute<CollectionRow[]>(
      `SELECT ${collectionColumns}
       FROM affair_collections c
       WHERE ${predicates.join(" AND ")}
       ORDER BY c.sort_order, c.id`,
      params,
    );
    return rows.map((row) => this.toCollection(row));
  }

  async getCollection(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollection | null> {
    const row = await this.getCollectionWith(this.pool, id, scope, false);
    return row ? this.toCollection(row) : null;
  }

  async createCollection(
    input: CreateAffairCollectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollection> {
    await this.assertAffair(this.pool, input.affairId, scope);
    if (input.type === "receipt") {
      await this.assertReceiptSlotAvailable(
        this.pool,
        input.affairId,
        input.target,
        scope,
      );
    }
    const [sortRows] = await this.pool.execute<SortRow[]>(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_sort
       FROM affair_collections
       WHERE tenant_id = ? AND affair_id = ?`,
      [scope.tenantId, input.affairId],
    );
    const id = randomUUID();
    const now = new Date();
    await this.pool.execute(
      `INSERT INTO affair_collections (
        id, tenant_id, affair_id, name, type, target, sort_order, status,
        settings, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
      [
        id,
        scope.tenantId,
        input.affairId,
        input.name,
        input.type,
        input.target,
        Number(sortRows[0]?.max_sort ?? -1) + 1,
        input.status,
        now,
        now,
      ],
    );
    const collection = await this.getCollection(id, scope);
    if (!collection) {
      throw new Error(
        "Affair collection insert succeeded but could not be read.",
      );
    }
    return collection;
  }

  async updateCollection(
    id: string,
    input: UpdateAffairCollectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollection> {
    const current = await this.getCollection(id, scope);
    if (!current) throw new NotFoundError("affair collection", id);
    const target = input.target ?? current.target;
    if (current.type === "receipt" && target !== current.target) {
      await this.assertReceiptSlotAvailable(
        this.pool,
        current.affairId,
        target,
        scope,
        id,
      );
    }
    const updates: string[] = [];
    const values: SqlValue[] = [];
    const put = (column: string, value: SqlValue): void => {
      updates.push(`${column} = ?`);
      values.push(value);
    };
    if (input.name !== undefined) put("name", input.name);
    if (input.target !== undefined) put("target", input.target);
    if (input.status !== undefined) put("status", input.status);
    if (input.sortOrder !== undefined) put("sort_order", input.sortOrder);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE affair_collections
       SET ${updates.length ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND version = ?`,
      [...values, new Date(), id, scope.tenantId, input.version],
    );
    if (result.affectedRows === 0) {
      await this.throwVersionFailure(
        "affair_collections",
        "affair collection",
        id,
        input.version,
        scope,
      );
    }
    const updated = await this.getCollection(id, scope);
    if (!updated) throw new NotFoundError("affair collection", id);
    return updated;
  }

  async listFields(scope: QuestionBankScope): Promise<AffairExcelField[]> {
    const [rows] = await this.pool.execute<FieldRow[]>(
      `SELECT ${fieldColumns}
       FROM affair_excel_fields f
       WHERE f.tenant_id = ?
       ORDER BY f.sort_order, f.id`,
      [scope.tenantId],
    );
    return rows.map((row) => this.toField(row));
  }

  async getField(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField | null> {
    const [rows] = await this.pool.execute<FieldRow[]>(
      `SELECT ${fieldColumns}
       FROM affair_excel_fields f
       WHERE f.id = ? AND f.tenant_id = ?
       LIMIT 1`,
      [id, scope.tenantId],
    );
    return rows[0] ? this.toField(rows[0]) : null;
  }

  async createField(
    input: CreateAffairExcelFieldInput,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField> {
    const [sortRows] = await this.pool.execute<SortRow[]>(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_sort
       FROM affair_excel_fields
       WHERE tenant_id = ?`,
      [scope.tenantId],
    );
    const id = randomUUID();
    const now = new Date();
    try {
      await this.pool.execute(
        `INSERT INTO affair_excel_fields (
          id, tenant_id, name, description, data_type, is_required,
          validation, select_options, sort_order, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          id,
          scope.tenantId,
          input.name,
          input.description,
          input.dataType,
          input.isRequired ? 1 : 0,
          encodeJson(input.validation),
          encodeJson(input.selectOptions),
          Number(sortRows[0]?.max_sort ?? -1) + 1,
          now,
          now,
        ],
      );
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          "An affair field with the same name already exists in this tenant.",
        );
      }
      throw error;
    }
    const field = await this.getField(id, scope);
    if (!field) {
      throw new Error("Affair field insert succeeded but could not be read.");
    }
    return field;
  }

  async updateField(
    id: string,
    input: UpdateAffairExcelFieldInput,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField> {
    const updates: string[] = [];
    const values: SqlValue[] = [];
    const put = (column: string, value: SqlValue): void => {
      updates.push(`${column} = ?`);
      values.push(value);
    };
    if (input.name !== undefined) put("name", input.name);
    if (input.description !== undefined) put("description", input.description);
    if (input.dataType !== undefined) put("data_type", input.dataType);
    if (input.isRequired !== undefined) {
      put("is_required", input.isRequired ? 1 : 0);
    }
    if (input.validation !== undefined) {
      put("validation", encodeJson(input.validation));
    }
    if (input.selectOptions !== undefined) {
      put("select_options", encodeJson(input.selectOptions));
    }
    if (input.sortOrder !== undefined) put("sort_order", input.sortOrder);
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE affair_excel_fields
         SET ${updates.length ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND version = ?`,
        [...values, new Date(), id, scope.tenantId, input.version],
      );
      if (result.affectedRows === 0) {
        await this.throwVersionFailure(
          "affair_excel_fields",
          "affair excel field",
          id,
          input.version,
          scope,
        );
      }
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          "An affair field with the same name already exists in this tenant.",
        );
      }
      throw error;
    }
    const updated = await this.getField(id, scope);
    if (!updated) throw new NotFoundError("affair excel field", id);
    return updated;
  }

  async deleteField(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const [counts] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS count
       FROM affair_excel_field_bindings
       WHERE tenant_id = ? AND field_id = ?`,
      [scope.tenantId, id],
    );
    const count = Number(counts[0]?.count ?? 0);
    if (count > 0) {
      throw new ConflictError(
        `This field is used by ${count} collection(s); remove the bindings first.`,
      );
    }
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM affair_excel_fields
       WHERE id = ? AND tenant_id = ? AND version = ?`,
      [id, scope.tenantId, version],
    );
    if (result.affectedRows === 0) {
      await this.throwVersionFailure(
        "affair_excel_fields",
        "affair excel field",
        id,
        version,
        scope,
      );
    }
  }

  async listBindings(
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollectionBinding[]> {
    await this.assertCollection(this.pool, collectionId, scope, false);
    return this.listBindingsWith(this.pool, collectionId, scope);
  }

  async replaceBindings(
    collectionId: string,
    input: ReplaceAffairCollectionBindingsInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollectionBinding[]> {
    await withTransaction(this.pool, async (connection) => {
      const collection = await this.assertCollection(
        connection,
        collectionId,
        scope,
        true,
      );
      if (collection.type !== "form" && collection.type !== "excel") {
        validationError(
          "Only form and excel collections support field bindings.",
        );
      }
      if (collection.type !== "form" && input.layout !== undefined) {
        validationError("Only form collections may define a layout.");
      }
      const seen = new Set<string>();
      for (const binding of input.bindings) {
        if (seen.has(binding.fieldId)) {
          validationError(
            "A field cannot be bound to the same collection more than once.",
          );
        }
        seen.add(binding.fieldId);
        const [fieldRows] = await connection.execute<IdRow[]>(
          `SELECT id FROM affair_excel_fields
           WHERE id = ? AND tenant_id = ?
           LIMIT 1`,
          [binding.fieldId, scope.tenantId],
        );
        if (!fieldRows[0]) {
          throw new NotFoundError("affair excel field", binding.fieldId);
        }
      }

      await connection.execute(
        `DELETE FROM affair_excel_field_bindings
         WHERE tenant_id = ? AND collection_id = ?`,
        [scope.tenantId, collectionId],
      );
      for (const [index, binding] of input.bindings.entries()) {
        await connection.execute(
          `INSERT INTO affair_excel_field_bindings (
            id, tenant_id, collection_id, field_id, is_required, sort_order
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            scope.tenantId,
            collectionId,
            binding.fieldId,
            binding.isRequired ? 1 : 0,
            index,
          ],
        );
      }
      if (collection.type === "form" && input.layout !== undefined) {
        await connection.execute(
          `UPDATE affair_collections
           SET settings = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ?`,
          [
            encodeJson({ layout: input.layout }),
            new Date(),
            collectionId,
            scope.tenantId,
          ],
        );
      }
    });
    return this.listBindings(collectionId, scope);
  }

  async listReferenceData(
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairReferenceDataRow[]> {
    const collection = await this.assertCollection(
      this.pool,
      collectionId,
      scope,
      false,
    );
    const table = this.referenceTable(collection.type);
    return this.listReferenceDataWith(this.pool, table, collectionId, scope);
  }

  async replaceReferenceData(
    collectionId: string,
    input: ReplaceAffairReferenceDataInput,
    scope: QuestionBankScope,
  ): Promise<AffairReferenceDataRow[]> {
    const table = await withTransaction(this.pool, async (connection) => {
      const collection = await this.assertCollection(
        connection,
        collectionId,
        scope,
        true,
      );
      const selectedTable = this.referenceTable(collection.type);

      if (collection.type === "excel" && input.rows.length > 0) {
        const [boundRows] = await connection.execute<IdRow[]>(
          `SELECT field_id AS id
           FROM affair_excel_field_bindings
           WHERE tenant_id = ? AND collection_id = ?`,
          [scope.tenantId, collectionId],
        );
        const bound = new Set(boundRows.map((row) => row.id));
        if (bound.size === 0) {
          validationError(
            "Excel reference data requires field bindings before rows can be stored.",
          );
        }
        for (const row of input.rows) {
          const keys = Object.keys(row);
          if (
            keys.length !== bound.size ||
            keys.some((key) => !bound.has(key))
          ) {
            validationError(
              "Excel reference-data keys must exactly match the bound field ids.",
            );
          }
        }
      }

      await connection.execute(
        `DELETE FROM ${selectedTable}
         WHERE tenant_id = ? AND collection_id = ?`,
        [scope.tenantId, collectionId],
      );
      for (const [index, row] of input.rows.entries()) {
        await connection.execute(
          `INSERT INTO ${selectedTable} (
            id, tenant_id, collection_id, row_data, sort_order, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            scope.tenantId,
            collectionId,
            JSON.stringify(row),
            index,
            new Date(),
          ],
        );
      }
      return selectedTable;
    });
    return this.listReferenceDataWith(this.pool, table, collectionId, scope);
  }

  private async assertAffair(
    executor: Executor,
    affairId: string,
    scope: QuestionBankScope,
  ): Promise<void> {
    const [rows] = await executor.execute<IdRow[]>(
      `SELECT id FROM affairs
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`,
      [affairId, scope.tenantId],
    );
    if (!rows[0]) throw new NotFoundError("affair", affairId);
  }

  private async getCollectionWith(
    executor: Executor,
    id: string,
    scope: QuestionBankScope,
    forUpdate: boolean,
  ): Promise<CollectionRow | null> {
    const [rows] = await executor.execute<CollectionRow[]>(
      `SELECT ${collectionColumns}
       FROM affair_collections c
       WHERE c.id = ? AND c.tenant_id = ?
       LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [id, scope.tenantId],
    );
    return rows[0] ?? null;
  }

  private async assertCollection(
    executor: Executor,
    id: string,
    scope: QuestionBankScope,
    forUpdate: boolean,
  ): Promise<AffairCollection> {
    const row = await this.getCollectionWith(executor, id, scope, forUpdate);
    if (!row) throw new NotFoundError("affair collection", id);
    return this.toCollection(row);
  }

  private async assertReceiptSlotAvailable(
    executor: Executor,
    affairId: string,
    target: AffairCollection["target"],
    scope: QuestionBankScope,
    excludeId?: string,
  ): Promise<void> {
    const params: SqlValue[] = [scope.tenantId, affairId, target];
    const exclude = excludeId ? " AND id <> ?" : "";
    if (excludeId) params.push(excludeId);
    const [rows] = await executor.execute<IdRow[]>(
      `SELECT id FROM affair_collections
       WHERE tenant_id = ? AND affair_id = ?
         AND type = 'receipt' AND target = ?${exclude}
       LIMIT 1`,
      params,
    );
    if (rows[0]) {
      throw new ConflictError(
        `A receipt collection for target ${target} already exists in this affair.`,
      );
    }
  }

  private referenceTable(
    type: AffairCollection["type"],
  ): "affair_form_ref_data" | "affair_excel_ref_data" {
    if (type === "form") return "affair_form_ref_data";
    if (type === "excel") return "affair_excel_ref_data";
    return validationError(
      "Only form and excel collections support reference data.",
    );
  }

  private async listBindingsWith(
    executor: Executor,
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollectionBinding[]> {
    const [rows] = await executor.execute<BindingRow[]>(
      `SELECT ${bindingColumns}
       FROM affair_excel_field_bindings b
       JOIN affair_excel_fields f
         ON f.id = b.field_id AND f.tenant_id = b.tenant_id
       WHERE b.tenant_id = ? AND b.collection_id = ?
       ORDER BY b.sort_order, b.id`,
      [scope.tenantId, collectionId],
    );
    return rows.map((row) => this.toBinding(row));
  }

  private async listReferenceDataWith(
    executor: Executor,
    table: "affair_form_ref_data" | "affair_excel_ref_data",
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairReferenceDataRow[]> {
    const [rows] = await executor.execute<RefRow[]>(
      `SELECT id, tenant_id, collection_id, row_data, sort_order, created_at
       FROM ${table}
       WHERE tenant_id = ? AND collection_id = ?
       ORDER BY sort_order, id`,
      [scope.tenantId, collectionId],
    );
    return rows.map((row) => this.toReferenceRow(row));
  }

  private async throwVersionFailure(
    table: "affair_collections" | "affair_excel_fields",
    resource: string,
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<never> {
    const [rows] = await this.pool.execute<VersionRow[]>(
      `SELECT version FROM ${table}
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`,
      [id, scope.tenantId],
    );
    if (!rows[0]) throw new NotFoundError(resource, id);
    if (Number(rows[0].version) !== version) {
      throw new ConflictError(`${resource} was modified by another request.`);
    }
    throw new Error(`${resource} update did not affect the expected row.`);
  }

  private toCollection(row: CollectionRow): AffairCollection {
    const parsedSettings = parseJson(row.settings);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      affairId: row.affair_id,
      name: row.name,
      type: row.type,
      target: row.target,
      sortOrder: Number(row.sort_order),
      status: row.status,
      settings:
        parsedSettings === null
          ? null
          : AffairCollectionSettingsSchema.parse(parsedSettings),
      version: Number(row.version),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private toField(row: FieldRow): AffairExcelField {
    const validation = parseJson(row.validation);
    const options = parseJson(row.select_options);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      description: row.description,
      dataType: row.data_type,
      isRequired: Boolean(row.is_required),
      validation:
        validation === null
          ? null
          : AffairExcelFieldValidationSchema.parse(validation),
      selectOptions:
        options === null ? null : AffairSelectOptionsSchema.parse(options),
      sortOrder: Number(row.sort_order),
      version: Number(row.version),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private toBinding(row: BindingRow): AffairCollectionBinding {
    const validation = parseJson(row.field_validation);
    const options = parseJson(row.field_select_options);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      collectionId: row.collection_id,
      fieldId: row.field_id,
      isRequired: Boolean(row.is_required),
      sortOrder: Number(row.sort_order),
      field: {
        id: row.field_id,
        tenantId: row.tenant_id,
        name: row.field_name,
        description: row.field_description,
        dataType: row.field_data_type,
        isRequired: Boolean(row.field_is_required),
        validation:
          validation === null
            ? null
            : AffairExcelFieldValidationSchema.parse(validation),
        selectOptions:
          options === null ? null : AffairSelectOptionsSchema.parse(options),
        sortOrder: Number(row.field_sort_order),
        version: Number(row.field_version),
        createdAt: toIso(row.field_created_at),
        updatedAt: toIso(row.field_updated_at),
      },
    };
  }

  private toReferenceRow(row: RefRow): AffairReferenceDataRow {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      collectionId: row.collection_id,
      rowData: AffairReferenceRowDataSchema.parse(parseJson(row.row_data)),
      sortOrder: Number(row.sort_order),
      createdAt: toIso(row.created_at),
    };
  }
}
