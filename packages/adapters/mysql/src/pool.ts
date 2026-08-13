import { createPool } from "mysql2/promise";
import type { Pool } from "mysql2/promise";

export const createMySqlPool = (connectionString: string): Pool =>
  createPool({
    uri: connectionString,
    timezone: "Z",
    dateStrings: ["DATETIME"],
  });
