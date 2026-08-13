import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Pool, PoolConnection } from "mysql2/promise";
import { runMigrations } from "../src/migrate.js";

type DirtyRun = {
  error_message: string | null;
};

class FakeMigrationConnection {
  readonly applied = new Set<string>();
  readonly dirty = new Map<string, DirtyRun>();
  readonly statements: string[] = [];
  failStatementContaining: string | undefined;
  released = false;

  async query(sql: string): Promise<[unknown, unknown]> {
    const normalized = sql.trim();
    this.statements.push(normalized);
    if (
      this.failStatementContaining &&
      normalized.includes(this.failStatementContaining)
    ) {
      throw new Error("simulated DDL failure");
    }
    return [[], []];
  }

  async execute(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<[unknown, unknown]> {
    const normalized = sql.trim();
    this.statements.push(normalized);

    if (normalized.startsWith("SELECT GET_LOCK")) {
      return [[{ acquired: 1 }], []];
    }
    if (normalized.startsWith("SELECT RELEASE_LOCK")) {
      return [[{ released: 1 }], []];
    }
    if (normalized.startsWith("SELECT id FROM schema_migrations")) {
      const id = String(parameters[0]);
      return [this.applied.has(id) ? [{ id }] : [], []];
    }
    if (normalized.startsWith("SELECT id, started_at")) {
      const id = String(parameters[0]);
      const dirty = this.dirty.get(id);
      return [dirty ? [{ id, ...dirty }] : [], []];
    }
    if (normalized.startsWith("INSERT INTO schema_migration_runs")) {
      this.dirty.set(String(parameters[0]), { error_message: null });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE schema_migration_runs")) {
      const id = String(parameters[2]);
      this.dirty.set(id, { error_message: String(parameters[1]) });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("INSERT INTO schema_migrations")) {
      this.applied.add(String(parameters[0]));
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("DELETE FROM schema_migration_runs")) {
      this.dirty.delete(String(parameters[0]));
      return [{ affectedRows: 1 }, []];
    }

    return [[], []];
  }

  release(): void {
    this.released = true;
  }
}

const asPool = (connection: FakeMigrationConnection): Pool =>
  ({
    getConnection: async () => connection as unknown as PoolConnection,
  }) as unknown as Pool;

describe("runMigrations", () => {
  it("records a dirty migration instead of pretending DDL can be rolled back", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "server-foundation-migrate-"),
    );
    try {
      const migrationPath = join(directory, "001_test.sql");
      await writeFile(
        migrationPath,
        "ALTER TABLE example ADD COLUMN first_col INT; ALTER TABLE example ADD COLUMN second_col INT;",
        "utf8",
      );

      const connection = new FakeMigrationConnection();
      connection.failStatementContaining = "second_col";
      const migration = {
        id: "001_test",
        file: pathToFileURL(migrationPath),
      };

      await expect(
        runMigrations(asPool(connection), [migration]),
      ).rejects.toThrow("Migration 001_test failed.");
      expect(connection.dirty.get("001_test")?.error_message).toContain(
        "simulated DDL failure",
      );
      expect(connection.applied.has("001_test")).toBe(false);
      expect(
        connection.statements.some((sql) =>
          /beginTransaction|rollback/i.test(sql),
        ),
      ).toBe(false);

      connection.failStatementContaining = undefined;
      const statementsBeforeRetry = connection.statements.length;
      await expect(
        runMigrations(asPool(connection), [migration]),
      ).rejects.toThrow("unfinished previous run");
      const retryStatements = connection.statements.slice(
        statementsBeforeRetry,
      );
      expect(
        retryStatements.some((sql) => sql.includes("ALTER TABLE example")),
      ).toBe(false);
      expect(connection.released).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
