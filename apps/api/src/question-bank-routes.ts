import { createHash } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  API_VERSION,
  API_VERSION_PREFIX,
  CreateExamineeGroupSchema,
  CreateExamineeSchema,
  CreateQuestionCategorySchema,
  CreateQuestionClusterSchema,
  CreateQuestionGroupSchema,
  CreateQuestionSchema,
  CreateTestBookletSchema,
  DeleteExamineeGroupQuerySchema,
  DeleteExamineeQuerySchema,
  DeleteQuestionCategoryQuerySchema,
  DeleteQuestionQuerySchema,
  DeleteQuestionStructureQuerySchema,
  DeleteTestBookletQuerySchema,
  ExamineeGroupListQuerySchema,
  ExamineeListQuerySchema,
  LEGACY_API_PREFIX,
  QuestionCategoryListQuerySchema,
  QuestionClusterListQuerySchema,
  QuestionGroupListQuerySchema,
  QuestionListQuerySchema,
  QuestionStatsQuerySchema,
  TestBookletListQuerySchema,
  UpdateExamineeGroupSchema,
  UpdateExamineeSchema,
  UpdateQuestionCategorySchema,
  UpdateQuestionClusterSchema,
  UpdateQuestionGroupSchema,
  UpdateQuestionSchema,
  UpdateTestBookletSchema,
} from "@server-foundation/api-contracts";
import type { AuthIdentity } from "@server-foundation/api-contracts";
import {
  CapabilityMissingError,
  ConflictError,
  DomainError,
  ExamineeService,
  QuestionBankService,
  QuestionImportService,
  QuestionStructureService,
  TestBookletService,
  UnauthorizedError,
} from "@server-foundation/domain";
import type {
  AuthenticationService,
  ExamineeRepository,
  IdempotencyStore,
  QuestionBankRepository,
  QuestionImportRepository,
  QuestionStructureRepository,
  TestBookletRepository,
} from "@server-foundation/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Logger } from "./logger.js";
import {
  examineeImportFingerprintPayload,
  importExamineeWorkbookFromRequest,
} from "./examinee-import-handler.js";
import {
  importQuestionWorkbookFromRequest,
  questionImportFingerprintPayload,
  questionImportTemplateResponse,
} from "./question-import-handler.js";

type QuestionEnv = {
  Variables: {
    requestId: string;
    identity: AuthIdentity | undefined;
    idempotencyApplied: boolean | undefined;
  };
};

type MountTarget = {
  route(path: string, app: Hono<QuestionEnv>): unknown;
};

type Dependencies = {
  repository: QuestionBankRepository;
  importRepository?: QuestionImportRepository;
  structureRepository?: QuestionStructureRepository;
  bookletRepository?: TestBookletRepository;
  examineeRepository?: ExamineeRepository;
  authenticationService?: AuthenticationService;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  allowUnauthenticated?: boolean;
  logger?: Logger;
};

const defaultIdempotencyTtlSeconds = 86_400;
const pendingIdempotencyTtlSeconds = 300;
const idempotentMethods = new Set(["POST", "PATCH", "DELETE"]);

const localDevelopmentIdentity: AuthIdentity = {
  userId: "local-development-user",
  email: "local-development@example.invalid",
  tenantId: "local-development-tenant",
  roles: ["developer"],
};

// ⚠️ 這兩個 helper 只吃 `context.get(...)` 與 `context.json(...)`，
//    所以用**結構型別**而不是 `Context<QuestionEnv>`：
//    `zValidator` 的 callback 交出來的是 Hono 預設的 `Context<Env>`，
//    綁死具體 Env 會在那裡型別不相容（`Variables` 是 `object | undefined`）。
type RequestIdContext = {
  get(key: "requestId"): string;
  json: Context["json"];
};
type IdentityContext = { get(key: "identity"): AuthIdentity | undefined };

const validationError = (context: RequestIdContext, message: string) =>
  context.json(
    {
      error: { code: "validation_error" as const, message },
      requestId: context.get("requestId"),
    },
    400,
  );

const bearerToken = (context: Context<QuestionEnv>): string => {
  const authorization = context.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError();
  return token;
};

const canonicalApiPath = (path: string): string =>
  path.replace(/^\/api\/v1(?=\/|$)/, "/api");

const idempotencyKeyFor = (
  context: Context<QuestionEnv>,
): string | undefined => {
  const raw = context.req.header("idempotency-key");
  if (raw === undefined) return undefined;
  const key = raw.trim();
  const invalid = Array.from(key).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x21 || code > 0x7e;
  });
  if (!key || key.length > 128 || invalid) {
    throw new DomainError(
      "validation_error",
      "Idempotency-Key must be 1-128 visible ASCII characters without whitespace.",
    );
  }
  return key;
};

const requestFingerprint = async (
  context: Context<QuestionEnv>,
): Promise<string> => {
  const url = new URL(context.req.url);
  const canonicalPath = canonicalApiPath(url.pathname);
  const hash = createHash("sha256");
  hash.update(context.req.method);
  hash.update("\n");
  hash.update(`${canonicalPath}${url.search}`);
  hash.update("\n");
  if (context.req.raw.body) {
    const importPayload =
      context.req.method === "POST" &&
      canonicalPath === `${LEGACY_API_PREFIX}/question-import`
        ? await questionImportFingerprintPayload(context.req.raw.clone())
        : context.req.method === "POST" &&
            canonicalPath === `${LEGACY_API_PREFIX}/examinee-import`
          ? await examineeImportFingerprintPayload(context.req.raw.clone())
          : null;
    hash.update(
      importPayload ?? Buffer.from(await context.req.raw.clone().arrayBuffer()),
    );
  }
  return hash.digest("hex");
};

const createQuestionRouter = (dependencies: Dependencies) => {
  const api = new Hono<QuestionEnv>();
  const service = new QuestionBankService(dependencies.repository);
  const importService = dependencies.importRepository
    ? new QuestionImportService(dependencies.importRepository)
    : undefined;
  const structureService = dependencies.structureRepository
    ? new QuestionStructureService(dependencies.structureRepository)
    : undefined;
  const bookletService = dependencies.bookletRepository
    ? new TestBookletService(dependencies.bookletRepository)
    : undefined;
  const examineeService = dependencies.examineeRepository
    ? new ExamineeService(dependencies.examineeRepository)
    : undefined;

  const requireImportService = (): QuestionImportService => {
    if (!importService) {
      throw new CapabilityMissingError("question import");
    }
    return importService;
  };

  const requireStructureService = (): QuestionStructureService => {
    if (!structureService) {
      throw new CapabilityMissingError("question structures");
    }
    return structureService;
  };

  const requireBookletService = (): TestBookletService => {
    if (!bookletService) {
      throw new CapabilityMissingError("test booklets");
    }
    return bookletService;
  };

  const requireExamineeService = (): ExamineeService => {
    if (!examineeService) {
      throw new CapabilityMissingError("examinees");
    }
    return examineeService;
  };

  const authenticate = async (
    context: Context<QuestionEnv>,
    next: () => Promise<void>,
  ) => {
    if (dependencies.authenticationService) {
      context.set(
        "identity",
        await dependencies.authenticationService.authenticate(
          bearerToken(context),
        ),
      );
    } else if (dependencies.allowUnauthenticated) {
      context.set("identity", localDevelopmentIdentity);
    } else {
      throw new CapabilityMissingError("authentication");
    }
    await next();
  };

  const enforceIdempotency = async (
    context: Context<QuestionEnv>,
    next: () => Promise<void>,
  ) => {
    if (!idempotentMethods.has(context.req.method)) {
      await next();
      return;
    }
    const key = idempotencyKeyFor(context);
    if (!key) {
      await next();
      return;
    }
    const store = dependencies.idempotencyStore;
    if (!store) throw new CapabilityMissingError("idempotency storage");
    const identity = context.get("identity");
    if (!identity) throw new UnauthorizedError();
    const url = new URL(context.req.url);
    const canonicalPath = canonicalApiPath(url.pathname);
    const scope = `${identity.tenantId}:${context.req.method}:${canonicalPath}`;
    const fingerprint = await requestFingerprint(context);
    const ttlSeconds =
      dependencies.idempotencyTtlSeconds ?? defaultIdempotencyTtlSeconds;
    const reservation = await store.reserve(
      scope,
      key,
      fingerprint,
      Math.min(pendingIdempotencyTtlSeconds, ttlSeconds),
    );

    if (reservation.state === "conflict") {
      throw new ConflictError(
        "Idempotency-Key was already used with a different request.",
      );
    }
    if (reservation.state === "pending") {
      throw new ConflictError(
        "A request with this Idempotency-Key is already in progress.",
      );
    }
    if (reservation.state === "completed") {
      const headers = new Headers({
        "Idempotency-Key": key,
        "X-Idempotent-Replay": "true",
        "X-Request-Id": context.get("requestId"),
        "X-API-Version": API_VERSION,
      });
      if (
        url.pathname.startsWith(`${LEGACY_API_PREFIX}/`) &&
        !url.pathname.startsWith(`${API_VERSION_PREFIX}/`)
      ) {
        headers.set("X-API-Legacy-Route", "true");
      }
      if (reservation.response.contentType) {
        headers.set("Content-Type", reservation.response.contentType);
      }
      return new Response(reservation.response.body || null, {
        status: reservation.response.status,
        headers,
      });
    }

    try {
      await next();
      context.header("Idempotency-Key", key);
      if (context.res.status >= 200 && context.res.status < 300) {
        const response = context.res.clone();
        await store
          .complete(
            scope,
            key,
            fingerprint,
            {
              status: response.status,
              body: await response.text(),
              contentType: response.headers.get("content-type") ?? undefined,
            },
            ttlSeconds,
          )
          .catch((error: unknown) => {
            dependencies.logger?.error("idempotency_commit_failed", {
              requestId: context.get("requestId"),
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } else {
        await store.release(scope, key, fingerprint);
      }
    } catch (error) {
      await store
        .release(scope, key, fingerprint)
        .catch((releaseError: unknown) => {
          dependencies.logger?.warn("idempotency_release_failed", {
            requestId: context.get("requestId"),
            error:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          });
        });
      throw error;
    }
  };

  for (const path of [
    "/questions",
    "/questions/*",
    "/question-categories",
    "/question-categories/*",
    "/question-clusters",
    "/question-clusters/*",
    "/question-groups",
    "/question-groups/*",
    "/test-booklets",
    "/test-booklets/*",
    "/examinee-groups",
    "/examinee-groups/*",
    "/examinees",
    "/examinees/*",
  ]) {
    api.use(path, authenticate);
    api.use(path, enforceIdempotency);
  }

  const scopeFor = (context: IdentityContext) => {
    const identity = context.get("identity");
    if (!identity) throw new UnauthorizedError();
    return { tenantId: identity.tenantId, actorUserId: identity.userId };
  };

  api.get("/question-import/template", authenticate, () =>
    questionImportTemplateResponse(),
  );

  api.post(
    "/question-import",
    authenticate,
    enforceIdempotency,
    async (context) => {
      const result = await importQuestionWorkbookFromRequest(
        context.req.raw,
        requireImportService(),
        scopeFor(context),
      );
      return result.ok
        ? context.json(
            { imported: result.imported, errors: result.errors },
            201,
          )
        : context.json({ imported: 0, errors: result.errors }, 400);
    },
  );

  api.get(
    "/questions",
    zValidator("query", QuestionListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid question query parameters.");
      }
    }),
    async (context) =>
      context.json(
        await service.listQuestions(
          context.req.valid("query"),
          scopeFor(context),
        ),
      ),
  );

  /**
   * 題庫統計卡（PHP `questionsView.php:17-41` 那張）。
   *
   * 🔴 **這一條必須註冊在 `/questions/:id` 之前**：Hono 依註冊順序比對，
   * 反過來寫的話 `stats` 會被當成題目 id ⇒ 永遠回 404。
   * ⇒ `apps/api/test/question-bank-stats.test.ts` 有一案專門釘住這個順序。
   */
  api.get(
    "/questions/stats",
    zValidator("query", QuestionStatsQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(
          context,
          "Invalid question stats query parameters.",
        );
      }
    }),
    async (context) =>
      context.json(
        await service.questionStats(
          context.req.valid("query"),
          scopeFor(context),
        ),
      ),
  );

  api.get("/questions/:id", async (context) =>
    context.json(
      await service.getQuestion(context.req.param("id"), scopeFor(context)),
    ),
  );

  api.post(
    "/questions",
    zValidator("json", CreateQuestionSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid question payload.");
      }
    }),
    async (context) =>
      context.json(
        await service.createQuestion(
          context.req.valid("json"),
          scopeFor(context),
        ),
        201,
      ),
  );

  api.patch(
    "/questions/:id",
    zValidator("json", UpdateQuestionSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid question payload.");
      }
    }),
    async (context) =>
      context.json(
        await service.updateQuestion(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
        ),
      ),
  );

  api.delete(
    "/questions/:id",
    zValidator("query", DeleteQuestionQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "A valid version is required.");
      }
    }),
    async (context) => {
      await service.softDeleteQuestion(
        context.req.param("id"),
        context.req.valid("query").version,
        scopeFor(context),
      );
      return context.body(null, 204);
    },
  );

  api.get(
    "/question-categories",
    zValidator("query", QuestionCategoryListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid category query parameters.");
      }
    }),
    async (context) =>
      context.json(
        await service.listCategories(
          context.req.valid("query"),
          scopeFor(context),
        ),
      ),
  );

  api.get("/question-categories/:id", async (context) =>
    context.json(
      await service.getCategory(context.req.param("id"), scopeFor(context)),
    ),
  );

  api.post(
    "/question-categories",
    zValidator("json", CreateQuestionCategorySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid category payload.");
      }
    }),
    async (context) =>
      context.json(
        await service.createCategory(
          context.req.valid("json"),
          scopeFor(context),
        ),
        201,
      ),
  );

  api.patch(
    "/question-categories/:id",
    zValidator("json", UpdateQuestionCategorySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid category payload.");
      }
    }),
    async (context) =>
      context.json(
        await service.updateCategory(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
        ),
      ),
  );

  api.delete(
    "/question-categories/:id",
    zValidator(
      "query",
      DeleteQuestionCategoryQuerySchema,
      (result, context) => {
        if (!result.success) {
          return validationError(context, "A valid version is required.");
        }
      },
    ),
    async (context) => {
      await service.softDeleteCategory(
        context.req.param("id"),
        context.req.valid("query").version,
        scopeFor(context),
      );
      return context.body(null, 204);
    },
  );

  api.get(
    "/question-clusters",
    zValidator("query", QuestionClusterListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(
          context,
          "Invalid question cluster query parameters.",
        );
      }
    }),
    async (context) =>
      context.json(
        await requireStructureService().listClusters(
          context.req.valid("query"),
          scopeFor(context),
        ),
      ),
  );

  api.get("/question-clusters/:id", async (context) =>
    context.json(
      await requireStructureService().getCluster(
        context.req.param("id"),
        scopeFor(context),
      ),
    ),
  );

  api.post(
    "/question-clusters",
    zValidator("json", CreateQuestionClusterSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid question cluster payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireStructureService().createCluster(
          context.req.valid("json"),
          scopeFor(context),
        ),
        201,
      ),
  );

  api.patch(
    "/question-clusters/:id",
    zValidator("json", UpdateQuestionClusterSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid question cluster payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireStructureService().updateCluster(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
        ),
      ),
  );

  api.delete(
    "/question-clusters/:id",
    zValidator(
      "query",
      DeleteQuestionStructureQuerySchema,
      (result, context) => {
        if (!result.success) {
          return validationError(context, "A valid version is required.");
        }
      },
    ),
    async (context) => {
      await requireStructureService().softDeleteCluster(
        context.req.param("id"),
        context.req.valid("query").version,
        scopeFor(context),
      );
      return context.body(null, 204);
    },
  );

  api.get(
    "/question-groups",
    zValidator("query", QuestionGroupListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(
          context,
          "Invalid question group query parameters.",
        );
      }
    }),
    async (context) =>
      context.json(
        await requireStructureService().listGroups(
          context.req.valid("query"),
          scopeFor(context),
        ),
      ),
  );

  api.get("/question-groups/:id", async (context) =>
    context.json(
      await requireStructureService().getGroup(
        context.req.param("id"),
        scopeFor(context),
      ),
    ),
  );

  api.post(
    "/question-groups",
    zValidator("json", CreateQuestionGroupSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid question group payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireStructureService().createGroup(
          context.req.valid("json"),
          scopeFor(context),
        ),
        201,
      ),
  );

  api.patch(
    "/question-groups/:id",
    zValidator("json", UpdateQuestionGroupSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid question group payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireStructureService().updateGroup(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
        ),
      ),
  );

  api.delete(
    "/question-groups/:id",
    zValidator(
      "query",
      DeleteQuestionStructureQuerySchema,
      (result, context) => {
        if (!result.success) {
          return validationError(context, "A valid version is required.");
        }
      },
    ),
    async (context) => {
      await requireStructureService().softDeleteGroup(
        context.req.param("id"),
        context.req.valid("query").version,
        scopeFor(context),
      );
      return context.body(null, 204);
    },
  );

  api.get(
    "/test-booklets",
    zValidator("query", TestBookletListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(
          context,
          "Invalid test booklet query parameters.",
        );
      }
    }),
    async (context) =>
      context.json(
        await requireBookletService().listBooklets(
          context.req.valid("query"),
          scopeFor(context),
        ),
      ),
  );

  api.get("/test-booklets/:id", async (context) =>
    context.json(
      await requireBookletService().getBooklet(
        context.req.param("id"),
        scopeFor(context),
      ),
    ),
  );

  api.post(
    "/test-booklets",
    zValidator("json", CreateTestBookletSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid test booklet payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireBookletService().createBooklet(
          context.req.valid("json"),
          scopeFor(context),
        ),
        201,
      ),
  );

  api.patch(
    "/test-booklets/:id",
    zValidator("json", UpdateTestBookletSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid test booklet payload.");
      }
    }),
    async (context) =>
      context.json(
        await requireBookletService().updateBooklet(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
        ),
      ),
  );

  api.delete(
    "/test-booklets/:id",
    zValidator("query", DeleteTestBookletQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "A valid version is required.");
      }
    }),
    async (context) => {
      await requireBookletService().softDeleteBooklet(
        context.req.param("id"),
        context.req.valid("query").version,
        scopeFor(context),
      );
      return context.body(null, 204);
    },
  );

  api.post("/test-booklets/:id/duplicate", async (context) =>
    context.json(
      await requireBookletService().duplicateBooklet(
        context.req.param("id"),
        scopeFor(context),
      ),
      201,
    ),
  );

  api.post(
    "/examinee-import",
    authenticate,
    enforceIdempotency,
    async (context) => {
      const result = await importExamineeWorkbookFromRequest(
        context.req.raw,
        requireExamineeService(),
        scopeFor(context),
      );
      return result.ok
        ? context.json(
            {
              imported: result.imported,
              updated: result.updated,
              errors: result.errors,
            },
            201,
          )
        : context.json({ imported: 0, updated: 0, errors: result.errors }, 400);
    },
  );

  api.get(
    "/examinee-groups",
    zValidator("query", ExamineeGroupListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(
          context,
          "Invalid examinee group query parameters.",
        );
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

  return api;
};

export const mountQuestionBankRoutes = (
  app: MountTarget,
  dependencies: Dependencies,
): void => {
  app.route(LEGACY_API_PREFIX, createQuestionRouter(dependencies));
  app.route(API_VERSION_PREFIX, createQuestionRouter(dependencies));
};
