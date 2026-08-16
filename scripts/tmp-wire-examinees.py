from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected marker once, got {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


# migration 009
replace_once(
    "packages/adapters/mysql/src/migrate.ts",
    '''  {\n    id: "008_test_booklets",\n    file: new URL("../schema/008_test_booklets.sql", import.meta.url),\n  },\n];''',
    '''  {\n    id: "008_test_booklets",\n    file: new URL("../schema/008_test_booklets.sql", import.meta.url),\n  },\n  {\n    id: "009_examinees",\n    file: new URL("../schema/009_examinees.sql", import.meta.url),\n  },\n];''',
)

# config: optional key path; mandatory for production
config = "apps/api/src/config.ts"
replace_once(
    config,
    '''  deploymentTenantUuid?: string;\n  fileCleanupIntervalMs: number;''',
    '''  deploymentTenantUuid?: string;\n  examineeCredentialKeyFile?: string;\n  fileCleanupIntervalMs: number;''',
)
replace_once(
    config,
    '''  const deploymentTenantUuid = parseOptionalTenantUuid(\n    env.DEPLOYMENT_TENANT_UUID,\n  );\n  const fileCleanupIntervalSeconds''',
    '''  const deploymentTenantUuid = parseOptionalTenantUuid(\n    env.DEPLOYMENT_TENANT_UUID,\n  );\n  const examineeCredentialKeyFile =\n    env.EXAMINEE_CREDENTIAL_KEY_FILE?.trim() || undefined;\n  const fileCleanupIntervalSeconds''',
)
replace_once(
    config,
    '''    (!mysqlUrl || !redisUrl || !fileStorageRoot || !deploymentTenantUuid)\n  ) {\n    throw new Error(\n      "MYSQL_URL, REDIS_URL, FILE_STORAGE_ROOT, and DEPLOYMENT_TENANT_UUID are required when NODE_ENV=production.",\n    );''',
    '''    (!mysqlUrl ||\n      !redisUrl ||\n      !fileStorageRoot ||\n      !deploymentTenantUuid ||\n      !examineeCredentialKeyFile)\n  ) {\n    throw new Error(\n      "MYSQL_URL, REDIS_URL, FILE_STORAGE_ROOT, DEPLOYMENT_TENANT_UUID, and EXAMINEE_CREDENTIAL_KEY_FILE are required when NODE_ENV=production.",\n    );''',
)
replace_once(
    config,
    '''    deploymentTenantUuid,\n    fileCleanupIntervalMs:''',
    '''    deploymentTenantUuid,\n    examineeCredentialKeyFile,\n    fileCleanupIntervalMs:''',
)

# deployment example
replace_once(
    "deploy/env/server-foundation.env.example",
    '''FILE_STORAGE_ROOT=/var/lib/server-foundation/storage\n\n# Non-secret machine identity''',
    '''FILE_STORAGE_ROOT=/var/lib/server-foundation/storage\n\n# 32-byte master key used for reversible examinee/proctor credentials.\n# Create once: umask 077; openssl rand -hex 32 > /etc/server-foundation/examinee-credential.key\n# Keep the populated file off Git and back it up separately with equivalent protection.\nEXAMINEE_CREDENTIAL_KEY_FILE=/etc/server-foundation/examinee-credential.key\n\n# Non-secret machine identity''',
)

# API router imports and service wiring
route = "apps/api/src/question-bank-routes.ts"
replace_once(route, '  CreateQuestionCategorySchema,\n', '  CreateExamineeGroupSchema,\n  CreateExamineeSchema,\n  CreateQuestionCategorySchema,\n')
replace_once(route, '  DeleteQuestionCategoryQuerySchema,\n', '  DeleteExamineeGroupQuerySchema,\n  DeleteExamineeQuerySchema,\n  DeleteQuestionCategoryQuerySchema,\n')
replace_once(route, '  LEGACY_API_PREFIX,\n', '  ExamineeGroupListQuerySchema,\n  ExamineeListQuerySchema,\n  LEGACY_API_PREFIX,\n')
replace_once(route, '  UpdateQuestionCategorySchema,\n', '  UpdateExamineeGroupSchema,\n  UpdateExamineeSchema,\n  UpdateQuestionCategorySchema,\n')
replace_once(route, '  DomainError,\n  QuestionBankService,', '  DomainError,\n  ExamineeService,\n  QuestionBankService,')
replace_once(route, '  AuthenticationService,\n  IdempotencyStore,', '  AuthenticationService,\n  ExamineeRepository,\n  IdempotencyStore,')
replace_once(
    route,
    '''  bookletRepository?: TestBookletRepository;\n  authenticationService?: AuthenticationService;''',
    '''  bookletRepository?: TestBookletRepository;\n  examineeRepository?: ExamineeRepository;\n  authenticationService?: AuthenticationService;''',
)
replace_once(
    route,
    '''  const bookletService = dependencies.bookletRepository\n    ? new TestBookletService(dependencies.bookletRepository)\n    : undefined;\n\n  const requireImportService''',
    '''  const bookletService = dependencies.bookletRepository\n    ? new TestBookletService(dependencies.bookletRepository)\n    : undefined;\n  const examineeService = dependencies.examineeRepository\n    ? new ExamineeService(dependencies.examineeRepository)\n    : undefined;\n\n  const requireImportService''',
)
replace_once(
    route,
    '''  const requireBookletService = (): TestBookletService => {\n    if (!bookletService) {\n      throw new CapabilityMissingError("test booklets");\n    }\n    return bookletService;\n  };\n\n  const authenticate''',
    '''  const requireBookletService = (): TestBookletService => {\n    if (!bookletService) {\n      throw new CapabilityMissingError("test booklets");\n    }\n    return bookletService;\n  };\n\n  const requireExamineeService = (): ExamineeService => {\n    if (!examineeService) {\n      throw new CapabilityMissingError("examinees");\n    }\n    return examineeService;\n  };\n\n  const authenticate''',
)
replace_once(
    route,
    '''    "/test-booklets",\n    "/test-booklets/*",\n  ]) {''',
    '''    "/test-booklets",\n    "/test-booklets/*",\n    "/examinee-groups",\n    "/examinee-groups/*",\n    "/examinees",\n    "/examinees/*",\n  ]) {''',
)

routes = r'''
  api.get(
    "/examinee-groups",
    zValidator("query", ExamineeGroupListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid examinee group query parameters.");
      }
    }),
    async (context) =>
      context.json(
        await requireExamineeService().listGroups(
          context.req.valid("query"),
          scopeFor(context),
        ),
      ),
  );

  api.get("/examinee-groups/:id", async (context) =>
    context.json(
      await requireExamineeService().getGroup(
        context.req.param("id"),
        scopeFor(context),
      ),
    ),
  );

  api.post(
    "/examinee-groups",
    zValidator("json", CreateExamineeGroupSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid examinee group payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireExamineeService().createGroup(
          context.req.valid("json"),
          scopeFor(context),
        ),
        201,
      ),
  );

  api.patch(
    "/examinee-groups/:id",
    zValidator("json", UpdateExamineeGroupSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid examinee group payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireExamineeService().updateGroup(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
        ),
      ),
  );

  api.delete(
    "/examinee-groups/:id",
    zValidator("query", DeleteExamineeGroupQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "A valid version is required.");
      }
    }),
    async (context) => {
      await requireExamineeService().softDeleteGroup(
        context.req.param("id"),
        context.req.valid("query").version,
        scopeFor(context),
      );
      return context.body(null, 204);
    },
  );

  api.get(
    "/examinees",
    zValidator("query", ExamineeListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid examinee query parameters.");
      }
    }),
    async (context) =>
      context.json(
        await requireExamineeService().listExaminees(
          context.req.valid("query"),
          scopeFor(context),
        ),
      ),
  );

  api.get("/examinees/by-identifier/:identifier", async (context) =>
    context.json(
      await requireExamineeService().findExamineeByIdentifier(
        context.req.param("identifier"),
        scopeFor(context),
      ),
    ),
  );

  api.get("/examinees/:id", async (context) =>
    context.json(
      await requireExamineeService().getExaminee(
        context.req.param("id"),
        scopeFor(context),
      ),
    ),
  );

  api.post(
    "/examinees",
    zValidator("json", CreateExamineeSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid examinee payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireExamineeService().createExaminee(
          context.req.valid("json"),
          scopeFor(context),
        ),
        201,
      ),
  );

  api.patch(
    "/examinees/:id",
    zValidator("json", UpdateExamineeSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid examinee payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireExamineeService().updateExaminee(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
        ),
      ),
  );

  api.delete(
    "/examinees/:id",
    zValidator("query", DeleteExamineeQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "A valid version is required.");
      }
    }),
    async (context) => {
      await requireExamineeService().softDeleteExaminee(
        context.req.param("id"),
        context.req.valid("query").version,
        scopeFor(context),
      );
      return context.body(null, 204);
    },
  );
'''
replace_once(route, '\n  return api;\n};', routes + '\n  return api;\n};')

# server composition
server = "apps/api/src/server.ts"
replace_once(server, 'import { access } from "node:fs/promises";', 'import { access, readFile } from "node:fs/promises";')
replace_once(server, '  createMySqlPool,\n  MySqlAuditLog,', '  AesGcmExamineeCredentialProtector,\n  createMySqlPool,\n  MySqlAuditLog,\n  MySqlExamineeRepository,')
replace_once(server, '  MySqlTestBookletRepository,\n  MySqlUserRepository,', '  MySqlTestBookletRepository,\n  MySqlUserRepository,\n  parseExamineeCredentialMasterKey,')
replace_once(server, '  createInMemoryItemRepository,\n', '  createInMemoryExamineeRepository,\n  createInMemoryItemRepository,\n')
replace_once(
    server,
    '''  const testBookletRepository = pool\n    ? new MySqlTestBookletRepository(pool)\n    : createInMemoryTestBookletRepository(\n        questionBankRepository,\n        questionStructureRepository,\n      );\n  const localBlobStorage''',
    '''  const testBookletRepository = pool\n    ? new MySqlTestBookletRepository(pool)\n    : createInMemoryTestBookletRepository(\n        questionBankRepository,\n        questionStructureRepository,\n      );\n  const examineeRepository = pool\n    ? new MySqlExamineeRepository(\n        pool,\n        new AesGcmExamineeCredentialProtector(\n          parseExamineeCredentialMasterKey(\n            await readFile(\n              config.examineeCredentialKeyFile ??\n                (() => {\n                  throw new Error(\n                    "EXAMINEE_CREDENTIAL_KEY_FILE is required when MYSQL_URL is configured.",\n                  );\n                })(),\n              "utf8",\n            ),\n          ),\n        ),\n      )\n    : createInMemoryExamineeRepository();\n  const localBlobStorage''',
)
replace_once(server, '    bookletRepository: testBookletRepository,\n', '    bookletRepository: testBookletRepository,\n    examineeRepository,\n')
replace_once(server, '    testBooklets: "enabled",\n', '    testBooklets: "enabled",\n    examinees: "enabled",\n')
