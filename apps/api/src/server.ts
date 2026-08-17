import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createClient } from "redis";
import { Argon2PasswordHasher, AuthService } from "@server-foundation/auth";
import {
  AesGcmAffairReceiptProtector,
  AesGcmExamineeCredentialProtector,
  createMySqlPool,
  MySqlAffairConfigurationRepository,
  MySqlAffairReceiptAccessLog,
  MySqlAffairReceiptRepository,
  MySqlAffairRepository,
  MySqlAffairSubmissionRepository,
  MySqlAuditLog,
  MySqlExamineeRepository,
  MySqlFileMetadataStore,
  MySqlIdempotencyStore,
  MySqlItemRepository,
  MySqlQuestionBankRepository,
  MySqlQuestionImportRepository,
  MySqlQuestionStructureRepository,
  MySqlTestBookletRepository,
  MySqlUserRepository,
  parseExamineeCredentialMasterKey,
} from "@server-foundation/mysql-adapter";
import {
  RedisRateLimiter,
  RedisSessionStore,
} from "@server-foundation/redis-adapter";
import {
  LocalFileStorage,
  startFileCleanupJob,
} from "@server-foundation/local-fs-storage";
import {
  createInMemoryAffairConfigurationRepository,
  createInMemoryAffairReceiptRepository,
  createInMemoryAffairRepository,
  createInMemoryAffairSubmissionRepository,
  createInMemoryExamineeRepository,
  createInMemoryItemRepository,
  createInMemoryQuestionBankRepository,
  createInMemoryQuestionImportRepository,
  createInMemoryQuestionStructureRepository,
  createInMemoryTestBookletRepository,
  InMemoryAffairReceiptAccessLog,
} from "@server-foundation/testing";
import { mountAffairConfigurationRoutes } from "./affair-configuration-routes.js";
import { mountAffairReceiptRoutes } from "./affair-receipt-routes.js";
import { mountAffairRoutes } from "./affair-routes.js";
import { mountAffairSubmissionRoutes } from "./affair-submission-routes.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { mountDeploymentIdentityRoutes } from "./deployment-identity-routes.js";
import { gracefulShutdown } from "./graceful-shutdown.js";
import { createJsonLogger, serializeError } from "./logger.js";
import { QuestionAwareBlobStorage } from "./question-aware-blob-storage.js";
import { mountQuestionBankRoutes } from "./question-bank-routes.js";

const config = loadConfig();
const logger = createJsonLogger();

const main = async () => {
  const pool = config.mysqlUrl ? createMySqlPool(config.mysqlUrl) : undefined;
  const redisClient = config.redisUrl
    ? createClient({ url: config.redisUrl })
    : undefined;

  if (redisClient) {
    redisClient.on("error", (error) =>
      logger.error("redis_client_error", { error: serializeError(error) }),
    );
    await redisClient.connect();
  }

  const sensitiveDataMasterKey = pool
    ? parseExamineeCredentialMasterKey(
        await readFile(
          config.examineeCredentialKeyFile ??
            (() => {
              throw new Error(
                "EXAMINEE_CREDENTIAL_KEY_FILE is required when MYSQL_URL is configured.",
              );
            })(),
          "utf8",
        ),
      )
    : undefined;

  const questionBankRepository = pool
    ? new MySqlQuestionBankRepository(pool)
    : createInMemoryQuestionBankRepository();
  const questionImportRepository = pool
    ? new MySqlQuestionImportRepository(pool)
    : createInMemoryQuestionImportRepository(questionBankRepository);
  const questionStructureRepository = pool
    ? new MySqlQuestionStructureRepository(pool)
    : createInMemoryQuestionStructureRepository(questionBankRepository);
  const testBookletRepository = pool
    ? new MySqlTestBookletRepository(pool)
    : createInMemoryTestBookletRepository(
        questionBankRepository,
        questionStructureRepository,
      );
  const examineeRepository = pool
    ? new MySqlExamineeRepository(
        pool,
        new AesGcmExamineeCredentialProtector(sensitiveDataMasterKey as Buffer),
      )
    : createInMemoryExamineeRepository();
  const affairRepository = pool
    ? new MySqlAffairRepository(pool)
    : createInMemoryAffairRepository();
  const affairConfigurationRepository = pool
    ? new MySqlAffairConfigurationRepository(pool)
    : createInMemoryAffairConfigurationRepository(affairRepository);
  const affairSubmissionRepository = pool
    ? new MySqlAffairSubmissionRepository(pool)
    : createInMemoryAffairSubmissionRepository(affairConfigurationRepository);
  const affairReceiptRepository = pool
    ? new MySqlAffairReceiptRepository(
        pool,
        new AesGcmAffairReceiptProtector(sensitiveDataMasterKey as Buffer),
      )
    : createInMemoryAffairReceiptRepository(affairRepository);
  const affairReceiptAccessLog = pool
    ? new MySqlAffairReceiptAccessLog(pool)
    : new InMemoryAffairReceiptAccessLog();
  const fileMetadataStore = pool ? new MySqlFileMetadataStore(pool) : undefined;
  const localBlobStorage = config.fileStorageRoot
    ? new LocalFileStorage(config.fileStorageRoot, {}, fileMetadataStore)
    : undefined;
  await localBlobStorage?.initialize();
  const fileCleanupJob = localBlobStorage
    ? startFileCleanupJob(localBlobStorage, {
        intervalMs: config.fileCleanupIntervalMs,
        onCleaned: (count) =>
          logger.info("file_cleanup_completed", { cleanedCount: count }),
        onError: (error) =>
          logger.error("file_cleanup_failed", { error: serializeError(error) }),
      })
    : undefined;

  const rateLimiter = redisClient
    ? new RedisRateLimiter(redisClient)
    : undefined;
  const idempotencyStore = pool ? new MySqlIdempotencyStore(pool) : undefined;
  const authenticationService =
    pool && redisClient
      ? new AuthService({
          users: new MySqlUserRepository(pool),
          sessions: new RedisSessionStore(redisClient),
          passwordHasher: new Argon2PasswordHasher(),
          rateLimiter,
        })
      : undefined;
  const itemRepository = pool
    ? new MySqlItemRepository(pool)
    : createInMemoryItemRepository();
  const blobStorage = localBlobStorage
    ? new QuestionAwareBlobStorage(
        localBlobStorage,
        questionBankRepository,
        questionStructureRepository,
      )
    : undefined;
  const auditLog = pool ? new MySqlAuditLog(pool) : undefined;

  const readinessChecks: Record<string, () => Promise<void>> = {};
  if (pool) {
    readinessChecks.mysql = async () => {
      await pool.query("SELECT 1");
    };
  }
  if (redisClient) {
    readinessChecks.redis = async () => {
      const response = await redisClient.ping();
      if (response !== "PONG") {
        throw new Error("Redis ping returned an unexpected response.");
      }
    };
  }
  if (config.fileStorageRoot) {
    readinessChecks.storage = async () => {
      await access(
        config.fileStorageRoot as string,
        constants.R_OK | constants.W_OK,
      );
    };
  }

  const app = createApp({
    itemRepository,
    authenticationService,
    blobStorage,
    auditLog,
    idempotencyStore,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    loginIpRateLimiter: rateLimiter,
    trustProxyHeaders: config.trustProxyHeaders,
    allowUnauthenticatedItems: !config.production && !authenticationService,
    readinessChecks,
    logger,
  });

  if (config.deploymentTenantUuid) {
    mountDeploymentIdentityRoutes(app, config.deploymentTenantUuid);
  }

  mountQuestionBankRoutes(app, {
    repository: questionBankRepository,
    importRepository: questionImportRepository,
    structureRepository: questionStructureRepository,
    bookletRepository: testBookletRepository,
    examineeRepository,
    authenticationService,
    idempotencyStore,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    allowUnauthenticated: !config.production && !authenticationService,
    logger,
  });

  mountAffairRoutes(app, {
    repository: affairRepository,
    authenticationService,
    idempotencyStore,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    allowUnauthenticated: !config.production && !authenticationService,
    logger,
  });

  mountAffairConfigurationRoutes(app, {
    repository: affairConfigurationRepository,
    authenticationService,
    idempotencyStore,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    allowUnauthenticated: !config.production && !authenticationService,
    logger,
  });

  mountAffairSubmissionRoutes(app, {
    repository: affairSubmissionRepository,
    affairRepository,
    configurationRepository: affairConfigurationRepository,
    auditLog,
    authenticationService,
    idempotencyStore,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    allowUnauthenticated: !config.production && !authenticationService,
    logger,
  });

  if (fileMetadataStore && blobStorage) {
    mountAffairReceiptRoutes(app, {
      repository: affairReceiptRepository,
      accessLog: affairReceiptAccessLog,
      affairRepository,
      fileMetadata: fileMetadataStore,
      blobStorage,
      authenticationService,
      idempotencyStore,
      idempotencyTtlSeconds: config.idempotencyTtlSeconds,
      allowUnauthenticated: !config.production && !authenticationService,
      trustProxyHeaders: config.trustProxyHeaders,
      logger,
    });
  }

  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });

  logger.info("server_started", {
    host: config.host,
    port: config.port,
    nodeEnv: config.nodeEnv,
    dataStore: pool ? "mysql" : "in-memory",
    authentication: authenticationService ? "enabled" : "disabled",
    privateFiles: blobStorage ? "enabled" : "disabled",
    questionBank: "enabled",
    questionImport: "enabled",
    questionStructures: "enabled",
    testBooklets: "enabled",
    examinees: "enabled",
    affairs: "enabled",
    affairConfigurations: "enabled",
    affairSubmissions: "enabled",
    affairReceipts: fileMetadataStore && blobStorage ? "enabled" : "disabled",
    auditLog: auditLog ? "enabled" : "disabled",
    idempotency: idempotencyStore ? "mysql-durable" : "disabled",
    trustProxyHeaders: config.trustProxyHeaders,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= gracefulShutdown({
      server,
      timeoutMs: config.shutdownTimeoutMs,
      stopBackgroundJobs: () => fileCleanupJob?.stop() ?? Promise.resolve(),
      closeResources: async () => {
        await Promise.all([pool?.end(), redisClient?.quit()]);
      },
    }).then(({ forcedHttpClose }) => {
      logger.info("server_stopped", { forcedHttpClose });
    });
    return shutdownPromise;
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    logger.info("shutdown_signal_received", { signal });
    void shutdown().catch((error) => {
      logger.error("graceful_shutdown_failed", {
        error: serializeError(error),
      });
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
};

await main().catch((error) => {
  logger.error("server_start_failed", { error: serializeError(error) });
  process.exitCode = 1;
});
