import { createMySqlPool } from "../dist/pool.js";
import { defaultMigrations, runMigrations } from "../dist/migrate.js";

const connectionString = process.env.MYSQL_URL;
if (!connectionString) {
  throw new Error("MYSQL_URL is required to run MySQL migrations.");
}

const pool = createMySqlPool(connectionString);
try {
  await runMigrations(pool, defaultMigrations);
  console.log(
    `Applied MySQL migrations: ${defaultMigrations.map(({ id }) => id).join(", ")}`,
  );
} finally {
  await pool.end();
}
