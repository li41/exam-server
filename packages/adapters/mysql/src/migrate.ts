import { readFile } from "node:fs/promises";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

export type Migration = {
  id: string;
  file: URL;
};

export const defaultMigrations: Migration[] = [
  {
    id: "001_items",
    file: new URL("../schema/001_items.sql", import.meta.url),
  },
  {
    id: "002_auth",
    file: new URL("../schema/002_auth.sql", import.meta.url),
  },
  {
    id: "003_files",
    file: new URL("../schema/003_files.sql", import.meta.url),
  },
  {
    id: "004_audit",
    file: new URL("../schema/004_audit.sql", import.meta.url),
  },
  {
    id: "005_idempotency",
    file: new URL("../schema/005_idempotency.sql", import.meta.url),
  },
  {
    id: "006_question_bank",
    file: new URL("../schema/006_question_bank.sql", import.meta.url),
  },
  {
    id: "007_question_structures",
    file: new URL("../schema/007_question_structures.sql", import.meta.url),
  },
];

const migrationLockName = "server-foundation:schema-migrations";
const migrationLockTimeoutSeconds = 30;

const migrationStatements = (sql: string): string[] =>
  sql
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message.slice(0, 2000)
    : String(error).slice(0, 2000);

const ensureMigrationTables = async (
  connection: PoolConnection,
): Promise<void> => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(100) NOT NULL,
      applied_at DATETIME(3) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migration_runs (
      id VARCHAR(100) NOT NULL,
      started_at DATETIME(3) NOT NULL,
      failed_at DATETIME(3) NULL,
      error_message TEXT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

const acquireMigrationLock = async (
  connection: PoolConnection,
): Promise<void> => {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT GET_LOCK(?, ?) AS acquired",
    [migrationLockName, migrationLockTimeoutSeconds],
  );
  if (Number(rows[0]?.acquired) !== 1) {
    throw new Error("Could not acquire the schema migration lock.");
  }
};

const releaseMigrationLock = async (
  connection: PoolConnection,
): Promise<void> => {
  await connection.execute("SELECT RELEASE_LOCK(?)", [migrationLockName]);
};

const isApplied = async (
  connection: PoolConnection,
  migrationId: string,
): Promise<boolean> => {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT id FROM schema_migrations WHERE id = ? LIMIT 1",
    [migrationId],
  );
  return rows.length > 0;
};

const assertNoDirtyRun = async (
  connection: PoolConnection,
  migrationId: string,
): Promise<void> => {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT id, started_at, failed_at, error_message FROM schema_migration_runs WHERE id = ? LIMIT 1",
    [migrationId],
  );
  const dirty = rows[0];
  if (!dirty) return;

  throw new Error(
    `Migration ${migrationId} has an unfinished previous run. MySQL DDL may have been partially applied and is not transactionally rollback-safe. Inspect the schema, repair it if necessary, then remove the schema_migration_runs row before retrying. Previous error: ${dirty.error_message ?? "process interrupted before an error was recorded"}`,
  );
};

const beginMigrationRun = async (
  connection: PoolConnection,
  migrationId: string,
): Promise<void> => {
  await connection.execute(
    "INSERT INTO schema_migration_runs (id, started_at, failed_at, error_message) VALUES (?, ?, NULL, NULL)",
    [migrationId, new Date()],
  );
};

const markMigrationFailed = async (
  connection: PoolConnection,
  migrationId: string,
  error: unknown,
): Promise<void> => {
  await connection.execute(
    "UPDATE schema_migration_runs SET failed_at = ?, error_message = ? WHERE id = ?",
    [new Date(), errorMessage(error), migrationId],
  );
};

const markMigrationApplied = async (
  connection: PoolConnection,
  migrationId: string,
): Promise<void> => {
  await connection.execute(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    [migrationId, new Date()],
  );
  await connection.execute("DELETE FROM schema_migration_runs WHERE id = ?", [
    migrationId,
  ]);
};

export async function runMigrations(
  pool: Pool,
  migrations: Migration[] = defaultMigrations,
): Promise<void> {
  const connection = await pool.getConnection();
  let lockAcquired = false;

  try {
    await acquireMigrationLock(connection);
    lockAcquired = true;
    await ensureMigrationTables(connection);

    for (const migration of migrations) {
      if (await isApplied(connection, migration.id)) {
        await connection.execute(
          "DELETE FROM schema_migration_runs WHERE id = ?",
          [migration.id],
        );
        continue;
      }

      await assertNoDirtyRun(connection, migration.id);
      await beginMigrationRun(connection, migration.id);

      try {
        const sql = await readFile(migration.file, "utf8");
        for (const statement of migrationStatements(sql)) {
          await connection.query(statement);
        }
        await markMigrationApplied(connection, migration.id);
      } catch (error) {
        await markMigrationFailed(connection, migration.id, error).catch(
          () => undefined,
        );
        throw new Error(`Migration ${migration.id} failed.`, { cause: error });
      }
    }
  } finally {
    if (lockAcquired) {
      await releaseMigrationLock(connection).catch(() => undefined);
    }
    connection.release();
  }
}
