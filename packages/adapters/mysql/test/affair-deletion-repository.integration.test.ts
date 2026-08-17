import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AesGcmAffairReceiptProtector,
  createMySqlPool,
  MySqlAffairDeletionRepository,
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
const deletion = new MySqlAffairDeletionRepository(pool);
const protector = new AesGcmAffairReceiptProtector(Buffer.alloc(32, 0x65));
const receipts = new MySqlAffairReceiptRepository(pool, protector);
const receiptAccessLog = new MySqlAffairReceiptAccessLog(pool);

const tenantA = {
  tenantId: "65000000-0000-4000-8000-000000000001",
  actorUserId: "65000000-0000-4000-8000-000000000002",
};
const tenantB = {
  tenantId: "65000000-0000-4000-8000-000000000099",
  actorUserId: "65000000-0000-4000-8000-000000000098",
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

const cleanup = async (): Promise<void> => {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of [
      "affair_receipt_access_logs",
      "affair_receipts",
      "affair_submission_data",
      "affair_submission_rows",
      "affair_submissions",
      "affair_excel_field_bindings",
      "affair_excel_ref_data",
      "affair_form_ref_data",
      "affair_collections",
      "affair_schools",
      "affair_cities",
      "affairs",
    ]) {
      await connection.execute(
        `DELETE FROM ${table} WHERE tenant_id IN (?, ?)`,
        [tenantA.tenantId, tenantB.tenantId],
      );
    }
  } finally {
    await connection.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => undefined);
    connection.release();
  }
};

const insertCollection = async (
  affairId: string,
  tenantId = tenantA.tenantId,
): Promise<string> => {
  const id = randomUUID();
  const now = new Date();
  await pool.execute(
    `INSERT INTO affair_collections (
      id, tenant_id, affair_id, name, type, target, sort_order, status,
      settings, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'collection', 'form', 'school', 0, 'enabled', NULL, 1, ?, ?)`,
    [id, tenantId, affairId, now, now],
  );
  return id;
};

const insertForeignBlocker = async (
  connection: PoolConnection,
  kind: "schools" | "submissions" | "receipts" | "collections",
  affairId: string,
): Promise<void> => {
  const now = new Date();
  if (kind === "schools") {
    await connection.execute(
      `INSERT INTO affair_schools (
        id, affair_id, tenant_id, city, school_level, school_code, school_name,
        test_classes, test_sessions, password, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, '臺北市', 1, ?, 'foreign school', 1, 1, 'pw', 'enabled', 1, ?, ?)`,
      [
        randomUUID(),
        affairId,
        tenantB.tenantId,
        randomUUID().slice(0, 12),
        now,
        now,
      ],
    );
    return;
  }
  if (kind === "collections") {
    await connection.execute(
      `INSERT INTO affair_collections (
        id, tenant_id, affair_id, name, type, target, sort_order, status,
        settings, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'foreign collection', 'form', 'school', 0, 'enabled', NULL, 1, ?, ?)`,
      [randomUUID(), tenantB.tenantId, affairId, now, now],
    );
    return;
  }
  if (kind === "submissions") {
    await connection.execute(
      `INSERT INTO affair_submissions (
        id, tenant_id, affair_id, collection_id, submitter_type, school_id,
        city_id, account_type, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'city', NULL, ?, 'EDU', 'draft', 1, ?, ?)`,
      [
        randomUUID(),
        tenantB.tenantId,
        affairId,
        randomUUID(),
        randomUUID(),
        now,
        now,
      ],
    );
    return;
  }
  await connection.execute(
    `INSERT INTO affair_receipts (
      id, tenant_id, affair_id, submitter_type, school_id, city_id,
      account_type, account, name, job_title, id_number, id_number_bidx,
      phone_area, phone_number, mobile, email, addr_city, addr_district,
      addr_detail, bank_id, bank_subid, bank_account, bankbook_file_id,
      positions, agreed, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'city', NULL, ?, 'EDU', ?, 'foreign', 'x', 'x', ?,
      'x', 'x', 'x', 'x', 'x', 'x', 'x', '004', '0001', 'x', ?, '[]', 1, 1, ?, ?)`,
    [
      randomUUID(),
      tenantB.tenantId,
      affairId,
      randomUUID(),
      `EDU-${randomUUID().slice(0, 8)}`,
      "a".repeat(64),
      randomUUID(),
      now,
      now,
    ],
  );
};

beforeAll(async () => {
  await runMigrations(pool);
});
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("MySqlAffairDeletionRepository", () => {
  it("blocks schools first", async () => {
    const affair = await affairs.createAffair(
      affairInput("school blocker"),
      tenantA,
    );
    await affairs.createSchool(
      {
        affairId: affair.id,
        city: "臺北市",
        schoolLevel: 1,
        schoolCode: "A001",
        schoolName: "A school",
        testClasses: 1,
        testSessions: 1,
        receiptCode: null,
        briefingOptions: null,
        password: null,
        status: "enabled",
      },
      tenantA,
    );

    await expect(
      deletion.deleteAffair(affair.id, affair.version, tenantA),
    ).resolves.toEqual({
      kind: "schools",
      count: 1,
    });
  });

  it("blocks submissions before their required collection", async () => {
    const affair = await affairs.createAffair(
      affairInput("submission blocker"),
      tenantA,
    );
    await affairs.initializeCities(tenantA);
    const city = (await affairs.listCities(tenantA))[0];
    expect(city).toBeDefined();
    const collectionId = await insertCollection(affair.id);
    const now = new Date();
    await pool.execute(
      `INSERT INTO affair_submissions (
        id, tenant_id, affair_id, collection_id, submitter_type, school_id,
        city_id, account_type, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'city', NULL, ?, 'EDU', 'draft', 1, ?, ?)`,
      [
        randomUUID(),
        tenantA.tenantId,
        affair.id,
        collectionId,
        city?.id,
        now,
        now,
      ],
    );

    await expect(
      deletion.deleteAffair(affair.id, affair.version, tenantA),
    ).resolves.toEqual({
      kind: "submissions",
      count: 1,
    });
  });

  it("blocks receipts", async () => {
    const affair = await affairs.createAffair(
      affairInput("receipt blocker"),
      tenantA,
    );
    await affairs.initializeCities(tenantA);
    const city = (await affairs.listCities(tenantA))[0];
    expect(city).toBeDefined();
    await receipts.createReceipt(
      {
        affairId: affair.id,
        submitterType: "city",
        cityId: city?.id as string,
        accountType: "EDU",
        account: "EDU01",
        name: "王小明",
        jobTitle: "承辦人",
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
        positions: [],
        monitorClasses: null,
        briefingRegion: null,
        transportType: null,
        transportOriginArea: null,
        transportOriginStation: null,
        transportDestStation: null,
        transportFee: null,
        agreed: true,
      },
      tenantA,
    );

    await expect(
      deletion.deleteAffair(affair.id, affair.version, tenantA),
    ).resolves.toEqual({
      kind: "receipts",
      count: 1,
    });
  });

  it("blocks collections after the other three categories are empty", async () => {
    const affair = await affairs.createAffair(
      affairInput("collection blocker"),
      tenantA,
    );
    await insertCollection(affair.id);

    await expect(
      deletion.deleteAffair(affair.id, affair.version, tenantA),
    ).resolves.toEqual({
      kind: "collections",
      count: 1,
    });
  });

  it("deletes the affair when no blockers exist", async () => {
    const affair = await affairs.createAffair(affairInput("deletable"), tenantA);
    await expect(
      deletion.deleteAffair(affair.id, affair.version, tenantA),
    ).resolves.toBeNull();
    await expect(affairs.getAffair(affair.id, tenantA)).resolves.toBeNull();
  });

  it("does not allow another tenant to delete the parent row", async () => {
    const affair = await affairs.createAffair(affairInput("tenant A"), tenantA);
    await expect(
      deletion.deleteAffair(affair.id, affair.version, tenantB),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(affairs.getAffair(affair.id, tenantA)).resolves.toMatchObject({
      id: affair.id,
    });
  });

  for (const kind of [
    "schools",
    "submissions",
    "receipts",
    "collections",
  ] as const) {
    it(`ignores a foreign-tenant ${kind} row with the same affair id`, async () => {
      const affair = await affairs.createAffair(
        affairInput(`foreign ${kind}`),
        tenantA,
      );
      const connection = await pool.getConnection();
      try {
        await connection.query("SET FOREIGN_KEY_CHECKS = 0");
        await insertForeignBlocker(connection, kind, affair.id);
      } finally {
        await connection
          .query("SET FOREIGN_KEY_CHECKS = 1")
          .catch(() => undefined);
        connection.release();
      }

      await expect(
        deletion.deleteAffair(affair.id, affair.version, tenantA),
      ).resolves.toBeNull();
      await expect(affairs.getAffair(affair.id, tenantA)).resolves.toBeNull();
    });
  }

  it("keeps receipt access audit after both receipt and affair business rows are deleted", async () => {
    const affair = await affairs.createAffair(
      affairInput("audit survives"),
      tenantA,
    );
    await affairs.initializeCities(tenantA);
    const city = (await affairs.listCities(tenantA))[0];
    expect(city).toBeDefined();
    const receipt = await receipts.createReceipt(
      {
        affairId: affair.id,
        submitterType: "city",
        cityId: city?.id as string,
        accountType: "EDU",
        account: "EDU02",
        name: "李小華",
        jobTitle: "承辦人",
        idNumber: "A123456789",
        residentCert: null,
        taxId: null,
        phoneArea: "02",
        phoneNumber: "87654321",
        phoneExt: null,
        mobile: "0912345678",
        email: "audit@example.test",
        addrCity: "臺北市",
        addrDistrict: "中正區",
        addrDetail: "測試路 2 號",
        bankId: "004",
        bankSubid: "0001",
        bankAccount: "9876543210",
        bankbookFileId: randomUUID(),
        positions: [],
        monitorClasses: null,
        briefingRegion: null,
        transportType: null,
        transportOriginArea: null,
        transportOriginStation: null,
        transportDestStation: null,
        transportFee: null,
        agreed: true,
      },
      tenantA,
    );
    await receiptAccessLog.record({
      tenantId: tenantA.tenantId,
      affairId: affair.id,
      actorType: "backend",
      actorUserId: tenantA.actorUserId,
      actorAccount: null,
      action: "delete",
      receiptId: receipt.id,
      recordCount: 1,
      ip: "203.0.113.65",
    });
    await receipts.deleteReceipt(receipt.id, receipt.version, tenantA);
    await expect(
      deletion.deleteAffair(affair.id, affair.version, tenantA),
    ).resolves.toBeNull();

    const [rows] = await pool.execute<
      Array<RowDataPacket & { receipt_id: string | null }>
    >(
      "SELECT receipt_id FROM affair_receipt_access_logs WHERE tenant_id = ? AND receipt_id = ?",
      [tenantA.tenantId, receipt.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.receipt_id).toBe(receipt.id);
  });
});
