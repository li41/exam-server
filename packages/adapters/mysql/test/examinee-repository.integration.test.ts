import {
  ConflictError,
  DomainError,
  NotFoundError,
} from "@server-foundation/domain";
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
  Buffer.alloc(32, 0x48),
);
const repository = new MySqlExamineeRepository(pool, credentials);
const scope = {
  tenantId: "48000000-0000-4000-8000-000000000001",
  actorUserId: "48000000-0000-4000-8000-000000000002",
};
const otherScope = {
  tenantId: "48000000-0000-4000-8000-000000000099",
  actorUserId: "48000000-0000-4000-8000-000000000098",
};

const createExaminee = (
  identifier: string,
  code: string,
  groupId: string | null = null,
) =>
  repository.createExaminee(
    {
      groupId,
      code,
      identifier,
      name: `受測者 ${identifier}`,
      note: null,
      status: "enabled",
    },
    scope,
  );

describe("MySqlExamineeRepository", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute("DELETE FROM examinees WHERE tenant_id IN (?, ?)", [
      scope.tenantId,
      otherScope.tenantId,
    ]);
    await pool.execute(
      "DELETE FROM examinee_groups WHERE tenant_id IN (?, ?)",
      [scope.tenantId, otherScope.tenantId],
    );
  });

  afterAll(async () => {
    await pool.execute("DELETE FROM examinees WHERE tenant_id IN (?, ?)", [
      scope.tenantId,
      otherScope.tenantId,
    ]);
    await pool.execute(
      "DELETE FROM examinee_groups WHERE tenant_id IN (?, ?)",
      [scope.tenantId, otherScope.tenantId],
    );
    await pool.end();
  });

  it("enforces tenant-scoped identifier and password uniqueness", async () => {
    const first = await createExaminee("UNIQUE-ID", "UNIQUE-CODE");
    expect(first.code).toBe("UNIQUE-CODE");

    await expect(
      repository.createExaminee(
        {
          groupId: null,
          code: "OTHER-CODE",
          identifier: "UNIQUE-ID",
          name: "duplicate identifier",
          note: null,
          status: "enabled",
        },
        scope,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(
      repository.createExaminee(
        {
          groupId: null,
          code: "UNIQUE-CODE",
          identifier: "OTHER-ID",
          name: "duplicate password",
          note: null,
          status: "enabled",
        },
        scope,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const foreign = await repository.createExaminee(
      {
        groupId: null,
        code: "UNIQUE-CODE",
        identifier: "UNIQUE-ID",
        name: "same values different tenant",
        note: null,
        status: "enabled",
      },
      otherScope,
    );
    expect(foreign.tenantId).toBe(otherScope.tenantId);

    await expect(
      repository.findExamineeByIdentifier("UNIQUE-ID", scope),
    ).resolves.toMatchObject({ id: first.id, tenantId: scope.tenantId });
    await expect(
      repository.findExamineeByIdentifier("UNIQUE-ID", otherScope),
    ).resolves.toMatchObject({ id: foreign.id, tenantId: otherScope.tenantId });
  });

  it("stores credentials encrypted while returning readable values", async () => {
    const group = await repository.createGroup(
      {
        parentId: null,
        name: "Credential group",
        proctorPassword: "PROCTOR-READABLE",
        sortOrder: 1,
      },
      scope,
    );
    const examinee = await createExaminee(
      "CRYPT-ID",
      "EXAMINEE-READABLE",
      group.id,
    );

    expect(group.proctorPassword).toBe("PROCTOR-READABLE");
    expect(examinee.code).toBe("EXAMINEE-READABLE");

    const [groupRows] = await pool.execute<any[]>(
      "SELECT proctor_password_ciphertext FROM examinee_groups WHERE id = ?",
      [group.id],
    );
    const [examineeRows] = await pool.execute<any[]>(
      "SELECT code_ciphertext, code_digest FROM examinees WHERE id = ?",
      [examinee.id],
    );
    const storedGroup = groupRows[0]?.proctor_password_ciphertext as string;
    const storedCode = examineeRows[0]?.code_ciphertext as string;
    const storedDigest = examineeRows[0]?.code_digest as string;
    expect(storedGroup).not.toContain("PROCTOR-READABLE");
    expect(storedCode).not.toContain("EXAMINEE-READABLE");
    expect(storedDigest).not.toBe("EXAMINEE-READABLE");
    expect(credentials.unprotect(storedGroup)).toBe("PROCTOR-READABLE");
    expect(credentials.unprotect(storedCode)).toBe("EXAMINEE-READABLE");
  });

  it("enforces exactly two group levels and hides foreign parent existence", async () => {
    const root = await repository.createGroup(
      {
        parentId: null,
        name: "Level root",
        proctorPassword: null,
        sortOrder: 10,
      },
      scope,
    );
    const child = await repository.createGroup(
      {
        parentId: root.id,
        name: "Level child",
        proctorPassword: null,
        sortOrder: 10,
      },
      scope,
    );
    const thirdLevelError = await repository
      .createGroup(
        {
          parentId: child.id,
          name: "Should fail",
          proctorPassword: null,
          sortOrder: 0,
        },
        scope,
      )
      .catch((error: unknown) => error);
    expect(thirdLevelError).toBeInstanceOf(DomainError);
    expect(thirdLevelError).toMatchObject({
      code: "validation_error",
      message: "Examinee groups support at most two levels.",
    });

    const foreignParent = await repository.createGroup(
      {
        parentId: null,
        name: "Foreign root",
        proctorPassword: null,
        sortOrder: 0,
      },
      otherScope,
    );
    const foreignError = await repository
      .createGroup(
        {
          parentId: foreignParent.id,
          name: "No disclosure",
          proctorPassword: null,
          sortOrder: 0,
        },
        scope,
      )
      .catch((error: unknown) => error);
    const missingId = "48000000-0000-4000-8000-00000000ffff";
    const missingError = await repository
      .createGroup(
        {
          parentId: missingId,
          name: "Also missing",
          proctorPassword: null,
          sortOrder: 0,
        },
        scope,
      )
      .catch((error: unknown) => error);
    expect(foreignError).toMatchObject({ code: "validation_error" });
    expect(missingError).toMatchObject({ code: "validation_error" });
    expect((foreignError as Error).message).toBe(
      `Examinee group parentId "${foreignParent.id}" does not exist.`,
    );
    expect(
      (missingError as Error).message.replace(missingId, foreignParent.id),
    ).toBe((foreignError as Error).message);
  });

  it("makes foreign and nonexistent group references indistinguishable", async () => {
    const foreignGroup = await repository.createGroup(
      {
        parentId: null,
        name: "Foreign examinee target",
        proctorPassword: null,
        sortOrder: 0,
      },
      otherScope,
    );
    const foreignError = await repository
      .createExaminee(
        {
          groupId: foreignGroup.id,
          code: "FOREIGN-GROUP-CODE",
          identifier: "FOREIGN-GROUP-ID",
          name: "foreign reference",
          note: null,
          status: "enabled",
        },
        scope,
      )
      .catch((error: unknown) => error);
    const missingId = "48000000-0000-4000-8000-00000000eeee";
    const missingError = await repository
      .createExaminee(
        {
          groupId: missingId,
          code: "MISSING-GROUP-CODE",
          identifier: "MISSING-GROUP-ID",
          name: "missing reference",
          note: null,
          status: "enabled",
        },
        scope,
      )
      .catch((error: unknown) => error);
    expect(foreignError).toMatchObject({ code: "validation_error" });
    expect(missingError).toMatchObject({ code: "validation_error" });
    expect(
      (missingError as Error).message.replace(missingId, foreignGroup.id),
    ).toBe((foreignError as Error).message);
  });

  it("group deletion cascades child removal and unassigns affected examinees only in the tenant", async () => {
    const root = await repository.createGroup(
      {
        parentId: null,
        name: "Delete root",
        proctorPassword: null,
        sortOrder: 20,
      },
      scope,
    );
    const child = await repository.createGroup(
      {
        parentId: root.id,
        name: "Delete child",
        proctorPassword: null,
        sortOrder: 20,
      },
      scope,
    );
    const rootExaminee = await createExaminee(
      "DELETE-ROOT-ID",
      "DELETE-ROOT-CODE",
      root.id,
    );
    const childExaminee = await createExaminee(
      "DELETE-CHILD-ID",
      "DELETE-CHILD-CODE",
      child.id,
    );

    await repository.softDeleteGroup(root.id, root.version, scope);
    await expect(repository.getGroup(root.id, scope)).resolves.toBeNull();
    await expect(repository.getGroup(child.id, scope)).resolves.toBeNull();
    await expect(
      repository.getExaminee(rootExaminee.id, scope),
    ).resolves.toMatchObject({
      groupId: null,
      version: 2,
    });
    await expect(
      repository.getExaminee(childExaminee.id, scope),
    ).resolves.toMatchObject({
      groupId: null,
      version: 2,
    });
  });

  it("never reads, updates, or deletes a foreign tenant examinee by id", async () => {
    const foreign = await repository.createExaminee(
      {
        groupId: null,
        code: "FOREIGN-ACCESS-CODE",
        identifier: "FOREIGN-ACCESS-ID",
        name: "foreign",
        note: null,
        status: "enabled",
      },
      otherScope,
    );

    await expect(repository.getExaminee(foreign.id, scope)).resolves.toBeNull();
    await expect(
      repository.updateExaminee(
        foreign.id,
        { name: "stolen", version: foreign.version },
        scope,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      repository.softDeleteExaminee(foreign.id, foreign.version, scope),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      repository.getExaminee(foreign.id, otherScope),
    ).resolves.toMatchObject({
      name: "foreign",
      deletedAt: null,
    });
  });
});
