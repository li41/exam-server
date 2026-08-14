const DATABASES = {
  idempotencyStore: 1,
  sessionStore: 2,
} as const;

const databaseIndexes = Object.values(DATABASES);
if (new Set(databaseIndexes).size !== databaseIndexes.length) {
  throw new Error("Redis integration test database indexes must be unique.");
}

export type RedisTestSuite = keyof typeof DATABASES;

export const redisTestUrl = (suite: RedisTestSuite): string | undefined => {
  const connectionString = process.env.REDIS_TEST_URL;
  if (!connectionString) return undefined;

  const url = new URL(connectionString);
  url.pathname = `/${DATABASES[suite]}`;
  return url.toString();
};
