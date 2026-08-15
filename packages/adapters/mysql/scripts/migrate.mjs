// ⚠️ package.json 的 `migrate` **不可以**加 `tsc -b` 前綴（2026-08-15 移除）。
//
// 它唯一的呼叫者是 deploy/scripts/install-release.sh:45，而那裡先跑
//   pnpm install --prod --frozen-lockfile
// ⇒ 目標機上**沒有 devDependencies、也就沒有 tsc** ⇒ 整條發布路徑會死在
//   `sh: line 1: tsc: command not found`。
//
// 也不需要建置：release tarball 已經含 dist/（package-release.mjs 打包整個 repo，
// 只排除 node_modules 等），下面 import 的 ../dist/*.js 在目標機上是現成的。
//
// 本機想「建置＋遷移」一次做完的話用 `pnpm --filter @server-foundation/mysql-adapter migrate:build`。
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
