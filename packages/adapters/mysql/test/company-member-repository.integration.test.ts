import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPANY_MEMBER_ADMIN_PERMISSIONS,
  COMPANY_MEMBER_NO_PERMISSIONS,
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

describe("MySqlCompanyMemberRepository", () => {
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

  it("keeps reads and updates tenant-scoped", async () => {
    const member = await repository.create(
      {
        userId: userA,
        invitedEmail: null,
        isAdmin: true,
        permissions: { ...COMPANY_MEMBER_ADMIN_PERMISSIONS },
        status: "active",
        reviewStatus: "approved",
        reviewedBy: null,
        reviewNote: null,
      },
      scopeA,
    );

    expect(await repository.get(member.id, scopeA)).toMatchObject({
      id: member.id,
      tenantId: tenantA,
    });
    expect((await repository.list({}, scopeA)).map(({ id }) => id)).toContain(
      member.id,
    );
    expect(await repository.findByUserId(userA, scopeA)).toMatchObject({
      id: member.id,
    });
    expect(await repository.findByUserId(userA, scopeB)).toBeNull();
    // prettier-ignore
    expect(
      await repository.countActiveApprovedAdmins(scopeA),
    ).toBeGreaterThan(0);
    expect(await repository.countActiveApprovedAdmins(scopeB)).toBe(0);
    expect(await repository.get(member.id, scopeB)).toBeNull();
    // prettier-ignore
    expect(
      (await repository.list({}, scopeB)).map(({ id }) => id),
    ).not.toContain(member.id);
    const updated = await repository.update(
      member.id,
      { reviewNote: "same-tenant update", version: member.version },
      scopeA,
    );
    expect(updated.reviewNote).toBe("same-tenant update");
    await expect(
      repository.update(
        member.id,
        { status: "disabled", version: updated.version },
        scopeB,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // prettier-ignore
  it("rejects a user from another tenant instead of creating a cross-tenant membership", async () => {
    await expect(
      repository.create(
        {
          userId: userB,
          invitedEmail: null,
          isAdmin: false,
          permissions: { ...COMPANY_MEMBER_NO_PERMISSIONS },
          status: "active",
          reviewStatus: "approved",
          reviewedBy: null,
          reviewNote: null,
        },
        scopeA,
      ),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
