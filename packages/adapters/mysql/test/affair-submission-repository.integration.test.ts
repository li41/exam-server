import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMySqlPool,
  MySqlAffairConfigurationRepository,
  MySqlAffairRepository,
  MySqlAffairSubmissionRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const affairs = new MySqlAffairRepository(pool);
const configurations = new MySqlAffairConfigurationRepository(pool);
const submissions = new MySqlAffairSubmissionRepository(pool);
const tenantA = {
  tenantId: "61000000-0000-4000-8000-000000000001",
  actorUserId: "61000000-0000-4000-8000-000000000002",
};
const tenantB = {
  tenantId: "61000000-0000-4000-8000-000000000099",
  actorUserId: "61000000-0000-4000-8000-000000000098",
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

const schoolInput = (affairId: string, code: string) => ({
  affairId,
  city: "臺北市",
  schoolLevel: 1 as const,
  schoolCode: code,
  schoolName: `學校 ${code}`,
  testClasses: 1 as const,
  testSessions: 1 as const,
  receiptCode: null,
  briefingOptions: null,
  password: null,
  status: "enabled" as const,
});

const cleanup = async (): Promise<void> => {
  const tenants = [tenantA.tenantId, tenantB.tenantId];
  await pool.execute(
    "DELETE FROM affair_submission_rows WHERE tenant_id IN (?, ?)",
    tenants,
  );
  await pool.execute(
    "DELETE FROM affair_submission_data WHERE tenant_id IN (?, ?)",
    tenants,
  );
  await pool.execute(
    "DELETE FROM affair_submissions WHERE tenant_id IN (?, ?)",
    tenants,
  );
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
  await pool.execute("DELETE FROM affair_cities WHERE tenant_id IN (?, ?)", tenants);
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

describe("MySqlAffairSubmissionRepository tenant isolation", () => {
  it("rejects foreign-tenant fields both in repository writes and direct child inserts", async () => {
    const affair = await affairs.createAffair(affairInput("A affair"), tenantA);
    const school = await affairs.createSchool(schoolInput(affair.id, "A001"), tenantA);
    const collection = await configurations.createCollection(
      {
        affairId: affair.id,
        name: "A form",
        type: "form",
        target: "school",
        status: "enabled",
      },
      tenantA,
    );
    const localField = await configurations.createField(fieldInput("A field"), tenantA);
    const foreignField = await configurations.createField(fieldInput("B field"), tenantB);
    await configurations.replaceBindings(
      collection.id,
      { bindings: [{ fieldId: localField.id, isRequired: false }] },
      tenantA,
    );

    const ensured = await submissions.ensureSubmission(
      {
        affairId: affair.id,
        collectionId: collection.id,
        submitterType: "school",
        schoolId: school.id,
        accountType: "SC",
      },
      tenantA,
    );

    await expect(
      submissions.saveDraft(
        ensured.item.id,
        {
          version: 1,
          payload: {
            kind: "form",
            fields: [{ fieldId: foreignField.id, value: "foreign" }],
          },
        },
        tenantA,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });

    await expect(
      pool.execute(
        `INSERT INTO affair_submission_data (
          id, tenant_id, submission_id, field_id, value
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          tenantA.tenantId,
          ensured.item.id,
          foreignField.id,
          "foreign",
        ],
      ),
    ).rejects.toBeTruthy();

    await expect(
      submissions.saveDraft(
        ensured.item.id,
        {
          version: 1,
          payload: {
            kind: "form",
            fields: [{ fieldId: localField.id, value: "local" }],
          },
        },
        tenantA,
      ),
    ).resolves.toMatchObject({
      status: "draft",
      version: 2,
      payload: { kind: "form", fields: [{ fieldId: localField.id, value: "local" }] },
    });
  });

  it("enforces tenant-qualified owners and the school/city XOR at the database boundary", async () => {
    const localAffair = await affairs.createAffair(affairInput("A affair"), tenantA);
    const foreignAffair = await affairs.createAffair(affairInput("B affair"), tenantB);
    const localSchool = await affairs.createSchool(
      schoolInput(localAffair.id, "A002"),
      tenantA,
    );
    const foreignSchool = await affairs.createSchool(
      schoolInput(foreignAffair.id, "B002"),
      tenantB,
    );
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
    const cities = await affairs.initializeCities(tenantA);
    const localCity = cities.items[0];
    expect(localCity).toBeTruthy();

    await expect(
      pool.execute(
        `INSERT INTO affair_submissions (
          id, tenant_id, affair_id, collection_id, submitter_type,
          school_id, city_id, account_type, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'school', ?, NULL, 'SC', 'draft', 1, ?, ?)`,
        [
          randomUUID(),
          tenantA.tenantId,
          localAffair.id,
          collection.id,
          foreignSchool.id,
          new Date(),
          new Date(),
        ],
      ),
    ).rejects.toBeTruthy();

    await expect(
      pool.execute(
        `INSERT INTO affair_submissions (
          id, tenant_id, affair_id, collection_id, submitter_type,
          school_id, city_id, account_type, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'school', ?, ?, 'SC', 'draft', 1, ?, ?)`,
        [
          randomUUID(),
          tenantA.tenantId,
          localAffair.id,
          collection.id,
          localSchool.id,
          localCity?.id,
          new Date(),
          new Date(),
        ],
      ),
    ).rejects.toBeTruthy();
  });
});
