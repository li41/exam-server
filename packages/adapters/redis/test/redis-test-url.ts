/**
 * ⚠️ DB 0 is taken by `apps/api/test/auth.integration.test.ts`, which reads
 * `REDIS_TEST_URL` directly (no path override) and calls `flushDb()` on it.
 * It is outside this registry, so the uniqueness check below cannot see it —
 * allocating 0 here would silently reintroduce the exact cross-file flush race
 * this module exists to prevent. Hence: allocations start at 1.
 */
const RESERVED_OUTSIDE_THIS_REGISTRY = 0;

const DATABASES = {
  idempotencyStore: 1,
  sessionStore: 2,
} as const;

const databaseIndexes = Object.values(DATABASES);
if (new Set(databaseIndexes).size !== databaseIndexes.length) {
  throw new Error("Redis integration test database indexes must be unique.");
}
if (databaseIndexes.some((index) => index <= RESERVED_OUTSIDE_THIS_REGISTRY)) {
  throw new Error(
    "Redis integration test database indexes must be >= 1; DB 0 belongs to apps/api/test/auth.integration.test.ts.",
  );
}

export type RedisTestSuite = keyof typeof DATABASES;

export const redisTestUrl = (suite: RedisTestSuite): string | undefined => {
  const connectionString = process.env.REDIS_TEST_URL;
  if (!connectionString) return undefined;

  const url = new URL(connectionString);
  url.pathname = `/${DATABASES[suite]}`;
  return url.toString();
};
