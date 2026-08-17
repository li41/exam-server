import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AesGcmAffairReceiptProtector,
  createMySqlPool,
  MySqlAffairReceiptAccessLog,
  MySqlAffairReceiptRepository,
  MySqlAffairRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const affairs = new MySqlAffairRepository(pool);
const protector = new AesGcmAffairReceiptProtector(Buffer.alloc(32, 0x62));
const receipts = new MySqlAffairReceiptRepository(pool, protector);
const accessLog = new MySqlAffairReceiptAccessLog(pool);
const tenantA = {
  tenantId: "62000000-0000-4000-8000-000000000001",
  actorUserId: "62000000-0000-4000-8000-000000000002",
};
const tenantB = {
  tenantId: "62000000-0000-4000-8000-000000000099",
  actorUserId: "62000000-0000-4000-8000-000000000098",
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

const schoolInput = (affairId: string, code: string) => ({
  affairId,
  city: "臺北市",
  schoolLevel: 2,
  schoolCode: code,
  schoolName: `${code} 國中`,
  testClasses: 1 as const,
  testSessions: 1 as const,
  receiptCode: null,
  briefingOptions: null,
  password: code,
  contacts: null,
  setupCompleted: [],
  status: "enabled" as const,
});

const receiptInput = (affairId: string, schoolId: string, account: string) => ({
  affairId,
  submitterType: "school" as const,
  schoolId,
  accountType: "SC" as const,
  account,
  name: "王小明",
  jobTitle: "主任",
  idNumber: "A123456789",
  residentCert: null,
  taxId: null,
  phoneArea: "02",
  phoneNumber: "12345678",
  phoneExt: null,
  mobile: "0912345678",
  email: "receipt@example.test",
  addrCity: "臺北市",
  addrDistrict: "中正區",
  addrDetail: "測試路 1 號",
  bankId: "004",
  bankSubid: "0001",
  bankAccount: "1234567890",
  bankbookFileId: randomUUID(),
  positions: ["學校聯絡人" as const],
  monitorClasses: null,
  briefingRegion: null,
  transportType: null,
  transportOriginArea: null,
  transportOriginStation: null,
  transportDestStation: null,
  transportFee: null,
  agreed: true,
});

const cleanup = async (): Promise<void> => {
  const tenants = [tenantA.tenantId, tenantB.tenantId];
  await pool.execute(
    "DELETE FROM affair_receipt_access_logs WHERE tenant_id IN (?, ?)",
    tenants,
  );
  await pool.execute("DELETE FROM affair_receipts WHERE tenant_id IN (?, ?)", tenants);
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

describe("MySqlAffairReceiptRepository security boundaries", () => {
  it("finds the matching blind index but not a different identity and keeps ciphertext at rest", async () => {
    const affair = await affairs.createAffair(affairInput("A affair"), tenantA);
    const school = await affairs.createSchool(schoolInput(affair.id, "A001"), tenantA);
    const created = await receipts.createReceipt(
      receiptInput(affair.id, school.id, "SCA001"),
      tenantA,
    );

    await expect(
      receipts.lookupByIdNumber(affair.id, "A123456789", tenantA),
    ).resolves.toMatchObject({ id: created.id, idNumber: "A123456789" });
    await expect(
      receipts.lookupByIdNumber(affair.id, "B120863514", tenantA),
    ).resolves.toBeNull();

    const [rows] = await pool.execute<
      Array<{ id_number: string; id_number_bidx: string; bank_account: string }>
    >(
      "SELECT id_number, id_number_bidx, bank_account FROM affair_receipts WHERE id = ?",
      [created.id],
    );
    expect(rows[0]?.id_number).not.toBe("A123456789");
    expect(rows[0]?.bank_account).not.toBe("1234567890");
    expect(rows[0]?.id_number_bidx).toBe(protector.digest("A123456789"));
  });

  it("rejects cross-tenant reads and cross-tenant school ownership at repository and FK layers", async () => {
    const affairA = await affairs.createAffair(affairInput("A affair"), tenantA);
    const schoolA = await affairs.createSchool(schoolInput(affairA.id, "A001"), tenantA);
    const affairB = await affairs.createAffair(affairInput("B affair"), tenantB);
    const schoolB = await affairs.createSchool(schoolInput(affairB.id, "B001"), tenantB);
    const created = await receipts.createReceipt(
      receiptInput(affairA.id, schoolA.id, "SCA001"),
      tenantA,
    );

    await expect(receipts.getReceipt(created.id, tenantB)).resolves.toBeNull();
    await expect(
      receipts.lookupByIdNumber(affairA.id, "A123456789", tenantB),
    ).resolves.toBeNull();

    await expect(
      pool.execute(
        `INSERT INTO affair_receipts (
          id, tenant_id, affair_id, submitter_type, school_id, city_id,
          account_type, account, name, job_title, id_number, id_number_bidx,
          phone_area, phone_number, mobile, email, addr_city, addr_district,
          addr_detail, bank_id, bank_subid, bank_account, bankbook_file_id,
          positions, agreed, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'school', ?, NULL, 'SC', ?, 'X', 'x', 'x', ?,
          'x', 'x', 'x', 'x', 'x', 'x', 'x', '004', '0001', 'x', ?, '[]', 1, 1, ?, ?)`,
        [
          randomUUID(),
          tenantA.tenantId,
          affairA.id,
          schoolB.id,
          "cross-tenant",
          "a".repeat(64),
          randomUUID(),
          new Date(),
          new Date(),
        ],
      ),
    ).rejects.toBeTruthy();
  });

  it("rejects invalid double-owner rows with the database XOR check", async () => {
    const affair = await affairs.createAffair(affairInput("A affair"), tenantA);
    const school = await affairs.createSchool(schoolInput(affair.id, "A001"), tenantA);
    await affairs.initializeCities(tenantA);
    const city = (await affairs.listCities(tenantA))[0];
    expect(city).toBeDefined();

    await expect(
      pool.execute(
        `INSERT INTO affair_receipts (
          id, tenant_id, affair_id, submitter_type, school_id, city_id,
          account_type, account, name, job_title, id_number, id_number_bidx,
          phone_area, phone_number, mobile, email, addr_city, addr_district,
          addr_detail, bank_id, bank_subid, bank_account, bankbook_file_id,
          positions, agreed, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'school', ?, ?, 'SC', ?, 'X', 'x', 'x', ?,
          'x', 'x', 'x', 'x', 'x', 'x', 'x', '004', '0001', 'x', ?, '[]', 1, 1, ?, ?)`,
        [
          randomUUID(),
          tenantA.tenantId,
          affair.id,
          school.id,
          city?.id,
          "double-owner",
          "b".repeat(64),
          randomUUID(),
          new Date(),
          new Date(),
        ],
      ),
    ).rejects.toBeTruthy();
  });

  it("keeps receipt access audit rows after the receipt is deleted", async () => {
    const affair = await affairs.createAffair(affairInput("A affair"), tenantA);
    const school = await affairs.createSchool(schoolInput(affair.id, "A001"), tenantA);
    const created = await receipts.createReceipt(
      receiptInput(affair.id, school.id, "SCA001"),
      tenantA,
    );
    await accessLog.record({
      tenantId: tenantA.tenantId,
      affairId: affair.id,
      actorType: "backend",
      actorUserId: tenantA.actorUserId,
      actorAccount: null,
      action: "delete",
      receiptId: created.id,
      recordCount: 1,
      ip: "203.0.113.20",
    });
    await receipts.deleteReceipt(created.id, created.version, tenantA);

    const [rows] = await pool.execute<Array<{ receipt_id: string | null }>>(
      "SELECT receipt_id FROM affair_receipt_access_logs WHERE tenant_id = ? AND receipt_id = ?",
      [tenantA.tenantId, created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.receipt_id).toBe(created.id);
  });
});
