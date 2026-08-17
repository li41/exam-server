import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMySqlPool,
  MySqlAffairConfigurationRepository,
  MySqlAffairRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const affairs = new MySqlAffairRepository(pool);
const configurations = new MySqlAffairConfigurationRepository(pool);
const tenantA = {
  tenantId: "59000000-0000-4000-8000-000000000001",
  actorUserId: "59000000-0000-4000-8000-000000000002",
};
const tenantB = {
  tenantId: "59000000-0000-4000-8000-000000000099",
  actorUserId: "59000000-0000-4000-8000-000000000098",
};

const affairInput = (name: string) => ({
  name,
  description: null,
  status: "enabled" as const,
  cityLoginStart: null,
  cityLoginEnd: null,
  schoolLoginStart: null,
  schoolLoginEnd: null,
  feeCityContact: 0,
  feeSchoolContact: 0,
  feeTeacherSetup: 0,
  feeTeacherMonitor1: 0,
  feeTeacherMonitor2: 0,
  feeTeacherMonitor3: 0,
  transportReceiptSchool: false,
  transportReceiptCity: false,
  briefingRegions: null,
  receiptYear: null,
  receiptNote: null,
  receiptPrintSchool: false,
  receiptPrintCity: false,
});

const fieldInput = (name: string) => ({
  name,
  description: null,
  dataType: "text" as const,
  isRequired: false,
  validation: null,
  selectOptions: null,
  sortOrder: 0,
});

const cleanup = async (): Promise<void> => {
  const tenants = [tenantA.tenantId, tenantB.tenantId];
  await pool.execute(
    "DELETE FROM affair_excel_ref_data WHERE tenant_id IN (?, ?)",
    tenants,
  );
  await pool.execute(
    "DELETE FROM affair_form_ref_data WHERE tenant_id IN (?, ?)",
    tenants,
  );
  await pool.execute(
    "DELETE FROM affair_excel_field_bindings WHERE tenant_id IN (?, ?)",
    tenants,
  );
  await pool.execute(
    "DELETE FROM affair_collections WHERE tenant_id IN (?, ?)",
    tenants,
  );
  await pool.execute(
    "DELETE FROM affair_excel_fields WHERE tenant_id IN (?, ?)",
    tenants,
  );
  await pool.execute("DELETE FROM affair_schools WHERE tenant_id IN (?, ?)", tenants);
  await pool.execute("DELETE FROM affairs WHERE tenant_id IN (?, ?)", tenants);
};

beforeAll(async () => {
  await runMigrations(pool);
});

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("MySqlAffairConfigurationRepository tenant isolation", () => {
  it("rejects a foreign-tenant field binding while same-tenant binding succeeds", async () => {
    const localAffair = await affairs.createAffair(affairInput("A affair"), tenantA);
    const collection = await configurations.createCollection(
      {
        affairId: localAffair.id,
        name: "A form",
        type: "form",
        target: "school",
        status: "enabled",
      },
      tenantA,
    );
    const foreignField = await configurations.createField(
      fieldInput("B field"),
      tenantB,
    );

    await expect(
      configurations.replaceBindings(
        collection.id,
        { bindings: [{ fieldId: foreignField.id, isRequired: false }] },
        tenantA,
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    await expect(
      pool.execute(
        `INSERT INTO affair_excel_field_bindings (
          id, tenant_id, collection_id, field_id, is_required, sort_order
        ) VALUES (?, ?, ?, ?, 0, 0)`,
        [randomUUID(), tenantA.tenantId, collection.id, foreignField.id],
      ),
    ).rejects.toBeTruthy();

    const localField = await configurations.createField(
      fieldInput("A field"),
      tenantA,
    );
    await expect(
      configurations.replaceBindings(
        collection.id,
        { bindings: [{ fieldId: localField.id, isRequired: true }] },
        tenantA,
      ),
    ).resolves.toMatchObject([
      { fieldId: localField.id, tenantId: tenantA.tenantId, isRequired: true },
    ]);
  });

  it("does not expose another tenant's collection or field", async () => {
    const affair = await affairs.createAffair(affairInput("A affair"), tenantA);
    const collection = await configurations.createCollection(
      {
        affairId: affair.id,
        name: "A excel",
        type: "excel",
        target: "city",
        status: "enabled",
      },
      tenantA,
    );
    const field = await configurations.createField(fieldInput("A field"), tenantA);

    await expect(configurations.getCollection(collection.id, tenantB)).resolves.toBeNull();
    await expect(configurations.getField(field.id, tenantB)).resolves.toBeNull();
    await expect(
      configurations.listCollections({ affairId: affair.id }, tenantB),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
