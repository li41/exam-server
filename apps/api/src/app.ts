import { createHash } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  API_VERSION,
  API_VERSION_PREFIX,
  AuthTokenResponseSchema,
  CreateItemSchema,
  DeleteItemQuerySchema,
  FileMetadataSchema,
  InitiateUploadRequestSchema,
  ItemListQuerySchema,
  LEGACY_API_PREFIX,
  LoginRequestSchema,
  RefreshRequestSchema,
  UploadProgressSchema,
  UpdateItemSchema,
} from "@server-foundation/api-contracts";
import type { AuthIdentity } from "@server-foundation/api-contracts";
import {
  CapabilityMissingError,
  ConflictError,
  DomainError,
  ItemService,
  RateLimitedError,
  UnauthorizedError,
} from "@server-foundation/domain";
import type {
  AuditLog,
  AuthenticationService,
  BlobStorage,
  IdempotencyStore,
  ItemRepository,
  RateLimiter,
} from "@server-foundation/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { noopLogger, serializeError } from "./logger.js";
import type { Logger } from "./logger.js";

type AppEnv = {
  Variables: {
    requestId: string;
    identity: AuthIdentity | undefined;
    idempotencyApplied: boolean | undefined;
  };
};

type RateLimitPolicy = {
  limit: number;
  windowSeconds: number;
};

type ReadinessChecks = Readonly<Record<string, () => Promise<void>>>;

const defaultLoginIpRateLimit: RateLimitPolicy = {
  limit: 50,
  windowSeconds: 60,
};

const defaultIdempotencyTtlSeconds = 86_400;
const pendingIdempotencyTtlSeconds = 300;
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const auditedMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const idempotentMethods = new Set(["POST", "PATCH", "DELETE"]);

const errorStatus = (code: DomainError["code"]): ContentfulStatusCode => {
  if (code === "validation_error" || code === "invalid_cursor") return 400;
  if (code === "checksum_mismatch") return 422;
  if (code === "upload_expired") return 410;
  if (code === "payload_too_large") return 413;
  if (code === "unauthorized") return 401;
  if (code === "forbidden") return 403;
  if (code === "rate_limited") return 429;
  if (code === "not_found") return 404;
  if (code === "conflict") return 409;
  return 501;
};

const validationError = (context: Context<any>, message: string) =>
  context.json(
    {
      error: { code: "validation_error" as const, message },
      requestId: context.get("requestId"),
    },
    400,
  );

const bearerToken = (context: Context<AppEnv>): string => {
  const authorization = context.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError();
  return token;
};

const trustedClientIp = (
  context: Context<AppEnv>,
  trustProxyHeaders: boolean,
): string | undefined => {
  if (!trustProxyHeaders) return undefined;
  const forwarded = context.req
    .header("x-forwarded-for")
    ?.split(",", 1)[0]
    ?.trim();
  const realIp = context.req.header("x-real-ip")?.trim();
  const candidate = forwarded || realIp;
  if (!candidate || candidate.length > 128 || /[\r\n]/.test(candidate)) {
    return undefined;
  }
  return candidate;
};

const requestIdFor = (candidate: string | undefined): string =>
  candidate && requestIdPattern.test(candidate)
    ? candidate
    : crypto.randomUUID();

const canonicalApiPath = (path: string): string =>
  path.replace(/^\/api\/v1(?=\/|$)/, "/api");

const auditResource = (path: string): { type: string; id?: string } => {
  const parts = canonicalApiPath(path).split("/").filter(Boolean);
  if (parts[1] === "items") {
    return { type: "item", ...(parts[2] ? { id: parts[2] } : {}) };
  }
  if (parts[1] === "files") {
    if (parts[2] === "upload-sessions") {
      return {
        type: "upload-session",
        ...(parts[3] ? { id: parts[3] } : {}),
      };
    }
    return { type: "file", ...(parts[2] ? { id: parts[2] } : {}) };
  }
  return { type: "api" };
};

const idempotencyKeyFor = (context: Context<AppEnv>): string | undefined => {
  const raw = context.req.header("idempotency-key");
  if (raw === undefined) return undefined;
  const key = raw.trim();
  const hasInvalidCharacter = Array.from(key).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x21 || code > 0x7e;
  });
  if (!key || key.length > 128 || hasInvalidCharacter) {
    throw new DomainError(
      "validation_error",
      "Idempotency-Key must be 1-128 visible ASCII characters without whitespace.",
    );
  }
  return key;
};

const requestFingerprint = async (
  context: Context<AppEnv>,
): Promise<string> => {
  const url = new URL(context.req.url);
  const canonicalTarget = `${canonicalApiPath(url.pathname)}${url.search}`;
  const hash = createHash("sha256");
  hash.update(context.req.method);
  hash.update("\n");
  hash.update(canonicalTarget);
  hash.update("\n");
  if (context.req.raw.body) {
    hash.update(Buffer.from(await context.req.raw.clone().arrayBuffer()));
  }
  return hash.digest("hex");
};

const localDevelopmentIdentity: AuthIdentity = {
  userId: "local-development-user",
  email: "local-development@example.invalid",
  tenantId: "local-development-tenant",
  roles: ["developer"],
};

type AppDependencies = {
  itemRepository: ItemRepository;
  authenticationService?: AuthenticationService;
  blobStorage?: BlobStorage;
  auditLog?: AuditLog;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  loginIpRateLimiter?: RateLimiter;
  loginIpRateLimit?: RateLimitPolicy;
  trustProxyHeaders?: boolean;
  allowUnauthenticatedItems?: boolean;
  readinessChecks?: ReadinessChecks;
  logger?: Logger;
};

export const createApp = (dependencies: AppDependencies) => {
  const app = new Hono<AppEnv>();
  const service = new ItemService(dependencies.itemRepository);
  const activeUploadSessions = new Set<string>();
  const logger = dependencies.logger ?? noopLogger;

  const mutateUploadSession = async <T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (activeUploadSessions.has(sessionId)) {
      throw new ConflictError("Upload session is already being modified.");
    }
    activeUploadSessions.add(sessionId);
    try {
      return await operation();
    } finally {
      activeUploadSessions.delete(sessionId);
    }
  };

  const enforceLoginIpRateLimit = async (
    context: Context<AppEnv>,
  ): Promise<void> => {
    const rateLimiter = dependencies.loginIpRateLimiter;
    if (!rateLimiter) return;
    const clientIp = trustedClientIp(
      context,
      dependencies.trustProxyHeaders === true,
    );
    if (!clientIp) return;
    const policy = dependencies.loginIpRateLimit ?? defaultLoginIpRateLimit;
    const result = await rateLimiter.consume(
      `auth:login:ip:${clientIp}`,
      policy.limit,
      policy.windowSeconds,
    );
    if (!result.allowed) {
      throw new RateLimitedError(result.retryAfterSeconds);
    }
  };

  app.use("*", async (context, next) => {
    const requestId = requestIdFor(context.req.header("x-request-id"));
    const startedAt = performance.now();
    const path = new URL(context.req.url).pathname;
    context.set("requestId", requestId);
    context.header("X-Request-Id", requestId);
    if (path.startsWith("/api/")) {
      context.header("X-API-Version", API_VERSION);
      if (!path.startsWith(`${API_VERSION_PREFIX}/`)) {
        context.header("X-API-Legacy-Route", "true");
      }
    }
    try {
      await next();
    } finally {
      const identity = context.get("identity");
      logger.info("http_request", {
        requestId,
        method: context.req.method,
        path,
        status: context.res.status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        ...(identity
          ? { userId: identity.userId, tenantId: identity.tenantId }
          : {}),
      });

      if (
        dependencies.auditLog &&
        identity &&
        path.startsWith("/api/") &&
        auditedMethods.has(context.req.method) &&
        context.res.status < 500
      ) {
        const resource = auditResource(path);
        await dependencies.auditLog
          .record({
            requestId,
            tenantId: identity.tenantId,
            actorUserId: identity.userId,
            action: `http.${context.req.method.toLowerCase()}`,
            resourceType: resource.type,
            resourceId: resource.id,
            metadata: {
              method: context.req.method,
              path: canonicalApiPath(path),
              status: context.res.status,
            },
          })
          .catch((error: unknown) => {
            logger.warn("audit_record_failed", {
              requestId,
              error: serializeError(error),
            });
          });
      }
    }
  });

  app.onError((error, context) => {
    const requestId = context.get("requestId");
    if (error instanceof DomainError) {
      const response = context.json(
        {
          error: { code: error.code, message: error.message },
          requestId,
        },
        errorStatus(error.code),
      );
      if (error.code === "rate_limited" && "retryAfterSeconds" in error) {
        response.headers.set("Retry-After", String(error.retryAfterSeconds));
      }
      return response;
    }

    logger.error("http_unhandled_error", {
      requestId,
      error: serializeError(error),
    });
    return context.json(
      {
        error: {
          code: "internal_error" as const,
          message: "An unexpected error occurred.",
        },
        500,
      );
  });

  app.notFound((context) =>
    context.json(
      {
        error: { code: "not_found" as const, message: "Route was not found." },
        requestId: context.get("requestId"),
      },
      404,
    ),
  );

  const liveness = (context: Context<AppEnv>) =>
    context.json({ status: "ok" as const });

  app.get("/health", liveness);
  app.get("/health/live", liveness);
  app.get("/health/ready", async (context) => {
    const entries = Object.entries(dependencies.readinessChecks ?? {});
    const results = await Promise.all(
      entries.map(async ([name, check]) => {
        try {
          await check();
          return [name, { status: "ok" as const }] as const;
        } catch (error) {
          logger.warn("readiness_check_failed", {
            check: name,
            error: serializeError(error),
          });
          return [name, { status: "error" as const }] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    const ready = results.every(([, result]) => result.status === "ok");
    return context.json(
      {
        status: ready ? ("ok" as const) : ("unavailable" as const),
        checks,
      },
      ready ? 200 : 503,
    );
  });

  const createApiRouter = () => {
    const api = new Hono<AppEnv>();

    api.post(
      "/auth/login",
      zValidator("json", LoginRequestSchema, (result, context) => {
        if (!result.success)
          return validationError(context, "Invalid login payload.");
      }),
      async (context) => {
        if (!dependencies.authenticationService) {
          throw new CapabilityMissingError("authentication");
        }
        await enforceLoginIpRateLimit(context);
        const tokens = await dependencies.authenticationService.login(
          context.req.valid("json"),
        );
        return context.json(AuthTokenResponseSchema.parse(tokens));
      },
    );

    api.post(
      "/auth/refresh",
      zValidator("json", RefreshRequestSchema, (result, context) => {
        if (!result.success)
          return validationError(context, "Invalid refresh payload.");
      }),
      async (context) => {
        if (!dependencies.authenticationService) {
          throw new CapabilityMissingError("authentication");
        }
        const tokens = await dependencies.authenticationService.refresh(
          context.req.valid("json").refreshToken,
        );
        return context.json(AuthTokenResponseSchema.parse(tokens));
      },
    );

    api.get("/auth/me", async (context) => {
      if (!dependencies.authenticationService) {
        throw new CapabilityMissingError("authentication");
      }
      const identity = await dependencies.authenticationService.authenticate(
        bearerToken(context),
      );
      return context.json(identity);
    });

    api.post("/auth/logout", async (context) => {
      if (!dependencies.authenticationService) {
        throw new CapabilityMissingError("authentication");
      }
      await dependencies.authenticationService.logout(bearerToken(context));
      return context.body(null, 204);
    });

    const authenticateProtected = async (
      context: Context<AppEnv>,
      next: () => Promise<void>,
    ) => {
      if (dependencies.authenticationService) {
        context.set(
          "identity",
          await dependencies.authenticationService.authenticate(
            bearerToken(context),
          ),
        );
      } else if (dependencies.allowUnauthenticatedItems) {
        context.set("identity", localDevelopmentIdentity);
      } else {
        throw new CapabilityMissingError("authentication");
      }
      await next();
    };

    const enforceIdempotency = async (
      context: Context<AppEnv>,
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
      if (context.get("idempotencyApplied")) {
        await next();
        return;
      }
      context.set("idempotencyApplied", true);
      const store = dependencies.idempotencyStore;
      if (!store) {
        throw new CapabilityMissingError("idempotency storage");
      }
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
              logger.error("idempotency_commit_failed", {
                requestId: context.get("requestId"),
                error: serializeError(error),
              });
            });
        } else {
          await store.release(scope, key, fingerprint);
        }
      } catch (error) {
        await store
          .release(scope, key, fingerprint)
          .catch((releaseError: unknown) => {
            logger.warn("idempotency_release_failed", {
              requestId: context.get("requestId"),
              error: serializeError(releaseError),
            });
          });
        throw error;
      }
    };

    api.use("/items", authenticateProtected);
    api.use("/items/*", authenticateProtected);
    api.use("/files", authenticateProtected);
    api.use("/files/*", authenticateProtected);
    api.use("/items", enforceIdempotency);
    api.use("/items/*", enforceIdempotency);
    api.use("/files", enforceIdempotency);
    api.use("/files/*", enforceIdempotency);

    const itemScope = (context: Context<AppEnv>) => {
      const identity = context.get("identity");
      if (!identity) throw new UnauthorizedError();
      return { tenantId: identity.tenantId };
    };

    const fileScope = (context: Context<AppEnv>) => {
      const identity = context.get("identity");
      if (!identity) throw new UnauthorizedError();
      return {
        userId: identity.userId,
        tenantId: identity.tenantId,
        roles: identity.roles,
      };
    };

    const requireBlobStorage = (): BlobStorage => {
      if (!dependencies.blobStorage) {
        throw new CapabilityMissingError("file storage");
      }
      return dependencies.blobStorage;
    };

    api.post(
      "/files/upload-sessions",
      zValidator("json", InitiateUploadRequestSchema, (result, context) => {
        if (!result.success)
          return validationError(context, "Invalid upload metadata.");
      }),
      async (context) => {
        const identity = context.get("identity");
        if (!identity) throw new UnauthorizedError();
        const session = await requireBlobStorage().initiateUpload({
          ...context.req.valid("json"),
          ownerId: identity.userId,
          tenantId: identity.tenantId,
        });
        return context.json(session, 201);
      },
    );

    api.put("/files/upload-sessions/:id/content", async (context) => {
      const body = context.req.raw.body;
      if (!body) return validationError(context, "Upload content is required.");
      const sessionId = context.req.param("id");
      const progress = await mutateUploadSession(sessionId, () =>
        requireBlobStorage().writeUpload(sessionId, body, fileScope(context)),
      );
      return context.json(UploadProgressSchema.parse(progress));
    });

    api.post("/files/upload-sessions/:id/complete", async (context) => {
      const sessionId = context.req.param("id");
      const metadata = await mutateUploadSession(sessionId, () =>
        requireBlobStorage().completeUpload(sessionId, fileScope(context)),
      );
      return context.json(metadata, 201);
    });

    api.delete("/files/upload-sessions/:id", async (context) => {
      const sessionId = context.req.param("id");
      await mutateUploadSession(sessionId, () =>
        requireBlobStorage().cancelUpload(sessionId, fileScope(context)),
      );
      return context.body(null, 204);
    });

    api.get("/files/:id/download", async (context) => {
      const download = await requireBlobStorage().getDownload(
        context.req.param("id"),
        fileScope(context),
      );
      const headers = new Headers({
        "Content-Length": String(download.contentLength),
        "Content-Type": download.mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.fileName)}`,
        "Accept-Ranges": "none",
      });
      return new Response(download.stream, { headers });
    });

    api.get("/files/:id", async (context) => {
      const metadata = await requireBlobStorage().getMetadata(
        context.req.param("id"),
        fileScope(context),
      );
      return context.json(FileMetadataSchema.parse(metadata));
    });

    api.delete("/files/:id", async (context) => {
      await requireBlobStorage().delete(
        context.req.param("id"),
        fileScope(context),
      );
      return context.body(null, 204);
    });

    api.get(
      "/items",
      zValidator("query", ItemListQuerySchema, (result, context) => {
        if (!result.success)
          return validationError(context, "Invalid query parameters.");
      }),
      async (context) => {
        const query = context.req.valid("query");
        return context.json(await service.list(query, itemScope(context)));
      },
    );

    api.get("/items/:id", async (context) => {
      return context.json(
        await service.get(context.req.param("id"), itemScope(context)),
      );
    });

    api.post(
      "/items",
      zValidator("json", CreateItemSchema, (result, context) => {
        if (!result.success)
          return validationError(context, "Invalid item payload.");
      }),
      async (context) => {
        const item = await service.create(
          context.req.valid("json"),
          itemScope(context),
        );
        return context.json(item, 201);
      },
    );

    api.patch(
      "/items/:id",
      zValidator("json", UpdateItemSchema, (result, context) => {
        if (!result.success)
          return validationError(context, "Invalid item payload.");
      }),
      async (context) => {
        const item = await service.update(
          context.req.param("id"),
          context.req.valid("json"),
          itemScope(context),
        );
        return context.json(item);
      },
    );

    api.delete(
      "/items/:id",
      zValidator("query", DeleteItemQuerySchema, (result, context) => {
        if (!result.success)
          return validationError(context, "A valid version is required.");
      }),
      async (context) => {
        const { version } = context.req.valid("query");
        await service.softDelete(
          context.req.param("id"),
          version,
          itemScope(context),
        );
        return context.body(null, 204);
      },
    );

    return api;
  };

  app.route(LEGACY_API_PREFIX, createApiRouter());
  app.route(API_VERSION_PREFIX, createApiRouter());

  return app;
};
