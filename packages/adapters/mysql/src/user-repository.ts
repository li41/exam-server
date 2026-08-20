import { randomUUID } from "node:crypto";
import type {
  NewUser,
  UserRecord,
  UserRepository,
} from "@server-foundation/domain";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type UserRow = RowDataPacket & {
  id: string;
  email: string;
  password_hash: string;
  tenant_id: string;
  roles: string | string[];
  disabled_at: Date | string | null;
};

const toIso = (value: Date | string | null): string | null => {
  if (value === null) return null;
  const date =
    value instanceof Date
      ? value
      : new Date(
          /[zZ]|[+-]\d\d:?\d\d$/.test(value)
            ? value.replace(" ", "T")
            : `${value.replace(" ", "T")}Z`,
        );
  if (Number.isNaN(date.getTime()))
    throw new Error("MySQL returned an invalid user date.");
  return date.toISOString();
};

const parseRoles = (value: string | string[]): string[] => {
  const roles = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")) {
    throw new Error("MySQL returned invalid user roles.");
  }
  return roles;
};

const toUser = (row: UserRow): UserRecord => ({
  userId: row.id,
  email: row.email,
  tenantId: row.tenant_id,
  roles: parseRoles(row.roles),
  passwordHash: row.password_hash,
  disabledAt: toIso(row.disabled_at),
});

export class MySqlUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [rows] = await this.pool.execute<UserRow[]>(
      `SELECT id, email, password_hash, tenant_id, roles, disabled_at
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [email.trim().toLowerCase()],
    );
    const row = rows[0];
    return row ? toUser(row) : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    const id = user.userId || randomUUID();
    const now = new Date();
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO users
        (id, email, display_name, password_hash, tenant_id, roles, created_at, updated_at, disabled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        user.email.trim().toLowerCase(),
        // 空字串一律當成沒填 ⇒ 題庫那側回 null、畫面顯示 `—`，
        // ⛔ 不會出現一個空白的「建立者」欄。
        user.displayName?.trim() || null,
        user.passwordHash,
        user.tenantId,
        JSON.stringify(user.roles),
        now,
        now,
      ],
    );
    const created = await this.findByEmail(user.email);
    if (!created)
      throw new Error(
        "MySQL user insert succeeded but the user was not found.",
      );
    return created;
  }
}
