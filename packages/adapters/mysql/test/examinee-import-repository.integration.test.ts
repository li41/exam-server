import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AesGcmExamineeCredentialProtector,
  createMySqlPool,
  MySqlExamineeRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const credentials = new AesGcmExamineeCredentialProtector(
  Buffer.alloc(32, 0x50),
);
const repository = new MySqlExamineeRepository(pool, credentials);
const scope = {
  tenantId: "50000000-0000-4000-8000-000000000001",
  actorUserId: "50000000-0000-4000-8000-000000000002",
};
const otherScope = {
  tenantId: "50000000-0000-4000-8000-000000000099",
  actorUserId: "50000000-0000-4000-8000-000000000098",
};

const record = (
  row: number,
  identifier: string,
  code: string,
  groupId: string | null = null,
) => ({
  sheet: "受測者",
  row,
  input: {
    groupId,
    code,
    identifier,
    name: `受測者 ${identifier}`,
    note: null,
    status: "enabled" as const,
  },
});

const cleanup = async () => {
  await pool.execute("DELETE FROM examinees WHERE tenant_id IN (?, ?)", [
    scope.tenantId,
    otherScope.tenantId,
  ]);
  await pool.execute(
    "DELETE FROM examinee_groups WHERE tenant_id IN (?, ?) AND parent_id IS NOT NULL",
    [scope.tenantId, otherScope.tenantId],
  );
  await pool.execute(
    "DELETE FROM examinee_groups WHERE tenant_id IN (?, ?) AND parent_id IS NULL",
    [scope.tenantId, otherScope.tenantId],
  );
};

describe("MySqlExamineeRepository spreadsheet import", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("imports through authenticated encryption and updates by identifier", async () => {
    const group = await repository.createGroup(
      {
        parentId: null,
        name: "Import group",
        proctorPassword: null,
        sortOrder: 0,
      },
      scope,
    );
    const first = await repository.importExaminees(
      [record(2, "IMPORT-1", "IMPORT-SECRET", group.id)],
      scope,
    );
    expect(first).toEqual({ imported: 1, updated: 0, errors: [] });
    const examinee = await repository.findExamineeByIdentifier(
      "IMPORT-1",
      scope,
    );
    expect(examinee).toMatchObject({
      groupId: group.id,
      code: "IMPORT-SECRET",
      version: 1,
    });

    const [rawRows] = await pool.execute<any[]>(
      "SELECT code_ciphertext, code_digest FROM examinees WHERE id = ?",
      [examinee!.id],
    );
    expect(rawRows[0]?.code_ciphertext).not.toContain("IMPORT-SECRET");
    expect(rawRows[0]?.code_digest).not.toBe("IMPORT-SECRET");
    expect(credentials.unprotect(rawRows[0]?.code_ciphertext as string)).toBe(
      "IMPORT-SECRET",
    );

    const updated = await repository.importExaminees(
      [
        {
          ...record(2, "IMPORT-1", "IMPORT-SECRET-NEW", null),
          input: {
            ...record(2, "IMPORT-1", "IMPORT-SECRET-NEW", null).input,
            name: "updated name",
            status: "disabled",
          },
        },
        record(3, "IMPORT-2", "IMPORT-SECRET-2"),
      ],
      scope,
    );
    expect(updated).toEqual({ imported: 1, updated: 1, errors: [] });
    await expect(
      repository.findExamineeByIdentifier("IMPORT-1", scope),
    ).resolves.toMatchObject({
      code: "IMPORT-SECRET-NEW",
      name: "updated name",
      status: "disabled",
      version: 2,
    });
  });

  it("returns row errors and leaves no partial writes on an existing-password conflict", async () => {
    await repository.createExaminee(
      {
        groupId: null,
        code: "TAKEN-IMPORT-CODE",
        identifier: "TAKEN-OWNER",
        name: "owner",
        note: null,
        status: "enabled",
      },
      scope,
    );
    const result = await repository.importExaminees(
      [
        record(2, "ROLLBACK-FIRST", "AVAILABLE-CODE"),
        record(3, "ROLLBACK-SECOND", "TAKEN-IMPORT-CODE"),
      ],
      scope,
    );
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        sheet: "受測者",
        row: 3,
        identifier: "ROLLBACK-SECOND",
        message: "受測者密碼已存在於此租戶。",
      }),
    ]);
    await expect(
      repository.findExamineeByIdentifier("ROLLBACK-FIRST", scope),
    ).resolves.toBeNull();
  });

  it("keeps import uniqueness and group references tenant-scoped", async () => {
    await repository.createExaminee(
      {
        groupId: null,
        code: "SHARED-IMPORT-CODE",
        identifier: "SHARED-IMPORT-ID",
        name: "foreign",
        note: null,
        status: "enabled",
      },
      otherScope,
    );
    const local = await repository.importExaminees(
      [record(2, "SHARED-IMPORT-ID", "SHARED-IMPORT-CODE")],
      scope,
    );
    expect(local).toEqual({ imported: 1, updated: 0, errors: [] });

    const foreignGroup = await repository.createGroup(
      {
        parentId: null,
        name: "Foreign import group",
        proctorPassword: null,
        sortOrder: 0,
      },
      otherScope,
    );
    const foreign = await repository.importExaminees(
      [record(3, "FOREIGN-GROUP-IMPORT", "FG-CODE", foreignGroup.id)],
      scope,
    );
    const missingId = "50000000-0000-4000-8000-00000000ffff";
    const missing = await repository.importExaminees(
      [record(4, "MISSING-GROUP-IMPORT", "MG-CODE", missingId)],
      scope,
    );
    expect(foreign.imported).toBe(0);
    expect(missing.imported).toBe(0);
    expect(foreign.errors[0]?.message).toBe(
      `Examinee groupId "${foreignGroup.id}" does not exist.`,
    );
    expect(missing.errors[0]?.message.replace(missingId, foreignGroup.id)).toBe(
      foreign.errors[0]?.message,
    );
  });
});
