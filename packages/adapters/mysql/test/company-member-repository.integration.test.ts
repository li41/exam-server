import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COMPANY_MEMBER_ADMIN_PERMISSIONS,
  COMPANY_MEMBER_NO_PERMISSIONS,
  ConflictError,
  DomainError,
  NotFoundError,
} from "@server-foundation/domain";
import {
  createMySqlPool,
  MySqlCompanyMemberRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const repository = new MySqlCompanyMemberRepository(pool);
const tenantA = "00000000-0000-4000-8000-000000000055";
const tenantB = "00000000-0000-4000-8000-000000000056";
const userA = "00000000-0000-4000-8000-0000000000a1";
const userB = "00000000-0000-4000-8000-0000000000b1";
const actorA = "00000000-0000-4000-8000-0000000000a2";
const memberA = "00000000-0000-4000-8000-0000000000c1";
const memberB = "00000000-0000-4000-8000-0000000000c2";
const scopeA = { tenantId: tenantA, actorUserId: actorA };
const scopeB = { tenantId: tenantB, actorUserId: userB };

const insertUser = async (id: string, email: string, tenantId: string) => {
  const now = new Date();
  await pool.execute(
    `INSERT INTO users
      (id, email, password_hash, tenant_id, roles, created_at, updated_at, disabled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      email,
      "integration-hash",
      tenantId,
      JSON.stringify(["user"]),
      now,
      now,
    ],
  );
};

const insertMember = async (
  id: string,
  userId: string,
  tenantId: string,
  isAdmin = false,
) => {
  const now = new Date();
  const permissions = isAdmin
    ? COMPANY_MEMBER_ADMIN_PERMISSIONS
    : COMPANY_MEMBER_NO_PERMISSIONS;
  await pool.execute(
    `INSERT INTO company_members
      (id, tenant_id, user_id, invited_email, is_admin, permissions,
       status, review_status, reviewed_by, reviewed_at, review_note,
       joined_at, updated_at, version)
     VALUES (?, ?, ?, NULL, ?, ?, 1, 1, NULL, NULL, NULL, ?, ?, 1)`,
    [
      id,
      tenantId,
      userId,
      isAdmin ? 1 : 0,
      JSON.stringify(permissions),
      now,
      now,
    ],
  );
};

const createInput = (userId: string) => ({
  userId,
  invitedEmail: null,
  isAdmin: false,
  permissions: { ...COMPANY_MEMBER_NO_PERMISSIONS },
  status: "active" as const,
  reviewStatus: "approved" as const,
  reviewedBy: null,
  reviewNote: null,
});

describe("MySqlCompanyMemberRepository tenant isolation", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute(
      "DELETE FROM company_members WHERE tenant_id IN (?, ?)",
      [tenantA, tenantB],
    );
    await pool.execute("DELETE FROM users WHERE id IN (?, ?, ?)", [
      userA,
      userB,
      actorA,
    ]);
    await insertUser(userA, "member-a@example.invalid", tenantA);
    await insertUser(actorA, "actor-a@example.invalid", tenantA);
    await insertUser(userB, "member-b@example.invalid", tenantB);
  });

  beforeEach(async () => {
    await pool.execute(
      "DELETE FROM company_members WHERE tenant_id IN (?, ?)",
      [tenantA, tenantB],
    );
  });

  afterAll(async () => {
    await pool.execute(
      "DELETE FROM company_members WHERE tenant_id IN (?, ?)",
      [tenantA, tenantB],
    );
    await pool.execute("DELETE FROM users WHERE id IN (?, ?, ?)", [
      userA,
      userB,
      actorA,
    ]);
    await pool.end();
  });

  it("keeps list tenant-scoped", async () => {
    await insertMember(memberA, userA, tenantA);
    await insertMember(memberB, userB, tenantB);

    const idsA = (await repository.list({}, scopeA)).map(({ id }) => id);
    const idsB = (await repository.list({}, scopeB)).map(({ id }) => id);
    expect(idsA).toContain(memberA);
    expect(idsA).not.toContain(memberB);
    expect(idsB).toContain(memberB);
    expect(idsB).not.toContain(memberA);
  });

  it("keeps get tenant-scoped", async () => {
    await insertMember(memberA, userA, tenantA);

    expect(await repository.get(memberA, scopeA)).toMatchObject({
      id: memberA,
      tenantId: tenantA,
    });
    expect(await repository.get(memberA, scopeB)).toBeNull();
  });

  it("keeps findByUserId tenant-scoped", async () => {
    await insertMember(memberA, userA, tenantA);

    expect(await repository.findByUserId(userA, scopeA)).toMatchObject({
      id: memberA,
      tenantId: tenantA,
    });
    expect(await repository.findByUserId(userA, scopeB)).toBeNull();
  });

  it("keeps update tenant-scoped", async () => {
    await insertMember(memberA, userA, tenantA);

    const updated = await repository.update(
      memberA,
      { reviewNote: "same-tenant update", version: 1 },
      scopeA,
    );
    expect(updated).toMatchObject({
      reviewNote: "same-tenant update",
      version: 2,
    });
    await expect(
      repository.update(
        memberA,
        { status: "disabled", version: updated.version },
        scopeB,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps update-failure probing tenant-scoped", async () => {
    await insertMember(memberA, userA, tenantA);

    await expect(
      repository.update(
        memberA,
        { reviewNote: "stale update", version: 0 },
        scopeA,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      repository.update(
        memberA,
        { reviewNote: "foreign stale update", version: 0 },
        scopeB,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps active-approved-admin count tenant-scoped", async () => {
    await insertMember(memberA, userA, tenantA, true);

    expect(await repository.countActiveApprovedAdmins(scopeA)).toBe(1);
    expect(await repository.countActiveApprovedAdmins(scopeB)).toBe(0);
  });

  it("rejects a foreign-tenant user on create", async () => {
    await expect(
      repository.create(createInput(userB), scopeA),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("accepts a same-tenant user on create", async () => {
    await expect(
      repository.create(createInput(userA), scopeA),
    ).resolves.toMatchObject({
      tenantId: tenantA,
      userId: userA,
    });
  });
});
