import { createHash } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  API_VERSION,
  API_VERSION_PREFIX,
  AffairSubmissionListQuerySchema,
  BatchReturnAffairSubmissionsSchema,
  DeleteAffairSubmissionQuerySchema,
  EnsureAffairSubmissionSchema,
  LEGACY_API_PREFIX,
  ReturnAffairSubmissionSchema,
  SaveAffairSubmissionSchema,
} from "@server-foundation/api-contracts";
import type { AuthIdentity } from "@server-foundation/api-contracts";
import {
  AffairSubmissionService,
  CapabilityMissingError,
  ConflictError,
  DomainError,
  UnauthorizedError,
} from "@server-foundation/domain";
import type {
  AffairConfigurationRepository,
  AffairRepository,
  AffairSubmissionRepository,
  AuditLog,
  AuthenticationService,
  IdempotencyStore,
} from "@server-foundation/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Logger } from "./logger.js";

type AffairSubmissionEnv = {
  Variables: {
    requestId: string;
    identity: AuthIdentity | undefined;
  };
};

type MountTarget = {
  route(path: string, app: Hono<AffairSubmissionEnv>): unknown;
};

type Dependencies = {
  repository: AffairSubmissionRepository;
  affairRepository: AffairRepository;
  configurationRepository: AffairConfigurationRepository;
  auditLog?: AuditLog;
  authenticationService?: AuthenticationService;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  allowUnauthenticated?: boolean;
  logger?: Logger;
};

type RequestIdContext = {
  get(key: "requestId"): string;
  json: Context["json"];
};
type IdentityContext = { get(key: "identity"): AuthIdentity | undefined };

const defaultIdempotencyTtlSeconds = 86_400;
const pendingIdempotencyTtlSeconds = 300;
const idempotentMethods = new Set(["POST", "PUT", "DELETE"]);
const localDevelopmentIdentity: AuthIdentity = {
  userId: "local-development-user",
  email: "local-development@example.invalid",
  tenantId: "local-development-tenant",
  roles: ["developer"],
};

const validationError = (context: RequestIdContext, message: string) =>
  context.json(
    {
      error: { code: "validation_error" as const, message },
      requestId: context.get("requestId"),
    },
    400,
  );

const bearerToken = (context: Context<AffairSubmissionEnv>): string => {
  const authorization = context.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError();
  return token;
};

const canonicalApiPath = (path: string): string =>
  path.replace(/^\/api\/v1(?=\/|$)/, "/api");

const idempotencyKeyFor = (
  context: Context<AffairSubmissionEnv>,
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
  context: Context<AffairSubmissionEnv>,
): Promise<string> => {
  const url = new URL(context.req.url);
  const hash = createHash("sha256");
  hash.update(context.req.method);
  hash.update("\n");
  hash.update(`${canonicalApiPath(url.pathname)}${url.search}`);
  hash.update("\n");
  if (context.req.raw.body) {
    hash.update(Buffer.from(await context.req.raw.clone().arrayBuffer()));
  }
  return hash.digest("hex");
};

const createAffairSubmissionRouter = (dependencies: Dependencies) => {
  const api = new Hono<AffairSubmissionEnv>();
  const service = new AffairSubmissionService(
    dependencies.repository,
    dependencies.affairRepository,
    dependencies.configurationRepository,
  );

  const authenticate = async (
    context: Context<AffairSubmissionEnv>,
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
    context: Context<AffairSubmissionEnv>,
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

  api.use("/affair-submissions", authenticate);
  api.use("/affair-submissions/*", authenticate);
  api.use("/affair-submissions", enforceIdempotency);
  api.use("/affair-submissions/*", enforceIdempotency);

  const scopeFor = (context: IdentityContext) => {
    const identity = context.get("identity");
    if (!identity) throw new UnauthorizedError();
    return { tenantId: identity.tenantId, actorUserId: identity.userId };
  };

  const auditBestEffort = async (
    context: Context<AffairSubmissionEnv>,
    action: string,
    resourceId?: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    if (!dependencies.auditLog) return;
    const identity = context.get("identity");
    if (!identity) return;
    await dependencies.auditLog
      .record({
        requestId: context.get("requestId"),
        tenantId: identity.tenantId,
        actorUserId: identity.userId,
        action,
        resourceType: "affair_submission",
        resourceId,
        metadata,
      })
      .catch((error: unknown) => {
        dependencies.logger?.warn("affair_submission_audit_failed", {
          requestId: context.get("requestId"),
          action,
          resourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  api.get(
    "/affair-submissions",
    zValidator("query", AffairSubmissionListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(
          context,
          "Invalid affair submission query parameters.",
        );
      }
    }),
    async (context) =>
      context.json(
        await service.listSubmissions(
          context.req.valid("query"),
          scopeFor(context),
        ),
      ),
  );

  api.post(
    "/affair-submissions/ensure",
    zValidator("json", EnsureAffairSubmissionSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid affair submission identity.");
      }
    }),
    async (context) => {
      const result = await service.ensureSubmission(
        context.req.valid("json"),
        scopeFor(context),
      );
      return result.created
        ? context.json(result, 201)
        : context.json(result, 200);
    },
  );

  api.post(
    "/affair-submissions/batch-return",
    zValidator(
      "json",
      BatchReturnAffairSubmissionsSchema,
      (result, context) => {
        if (!result.success) {
          return validationError(context, "Invalid batch return payload.");
        }
      },
    ),
    async (context) => {
      const input = context.req.valid("json");
      const result = await service.batchReturn(input, scopeFor(context));
      await auditBestEffort(
        context,
        "affair_submission_batch_return",
        undefined,
        {
          requested: input.items.length,
          returned: result.returned,
          skipped: result.skipped,
        },
      );
      return context.json(result);
    },
  );

  api.get("/affair-submissions/:id", async (context) =>
    context.json(
      await service.getSubmission(context.req.param("id"), scopeFor(context)),
    ),
  );

  api.put(
    "/affair-submissions/:id/draft",
    zValidator("json", SaveAffairSubmissionSchema, (result, context) => {
      if (!result.success) {
        return validationError(
          context,
          "Invalid affair submission draft payload.",
        );
      }
    }),
    async (context) =>
      context.json(
        await service.saveDraft(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
        ),
      ),
  );

  api.post(
    "/affair-submissions/:id/submit",
    zValidator("json", SaveAffairSubmissionSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid affair submission payload.");
      }
    }),
    async (context) =>
      context.json(
        await service.submit(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
        ),
      ),
  );

  api.post(
    "/affair-submissions/:id/return",
    zValidator("json", ReturnAffairSubmissionSchema, (result, context) => {
      if (!result.success) {
        return validationError(
          context,
          "Invalid affair submission return payload.",
        );
      }
    }),
    async (context) => {
      const input = context.req.valid("json");
      const result = await service.returnSubmission(
        context.req.param("id"),
        input.version,
        input.reason,
        scopeFor(context),
      );
      await auditBestEffort(context, "affair_submission_return", result.id, {
        reasonProvided: input.reason !== null && input.reason.length > 0,
      });
      return context.json(result);
    },
  );

  api.delete(
    "/affair-submissions/:id",
    zValidator(
      "query",
      DeleteAffairSubmissionQuerySchema,
      (result, context) => {
        if (!result.success) {
          return validationError(context, "A valid version is required.");
        }
      },
    ),
    async (context) => {
      const id = context.req.param("id");
      await service.deleteSubmission(
        id,
        context.req.valid("query").version,
        scopeFor(context),
      );
      await auditBestEffort(context, "affair_submission_delete", id);
      return context.body(null, 204);
    },
  );

  return api;
};

export const mountAffairSubmissionRoutes = (
  app: MountTarget,
  dependencies: Dependencies,
): void => {
  app.route(LEGACY_API_PREFIX, createAffairSubmissionRouter(dependencies));
  app.route(API_VERSION_PREFIX, createAffairSubmissionRouter(dependencies));
};
