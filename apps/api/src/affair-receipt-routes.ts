import { createHash } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  API_VERSION,
  API_VERSION_PREFIX,
  AffairReceiptListQuerySchema,
  AffairReceiptLookupSchema,
  AffairReceiptSelectionSchema,
  CreateAffairReceiptSchema,
  DeleteAffairReceiptQuerySchema,
  LEGACY_API_PREFIX,
  UpdateAffairReceiptSchema,
} from "@server-foundation/api-contracts";
import type { AuthIdentity } from "@server-foundation/api-contracts";
import {
  AffairReceiptService,
  CapabilityMissingError,
  ConflictError,
  DomainError,
  UnauthorizedError,
} from "@server-foundation/domain";
import type {
  AffairReceiptAccessLog,
  AffairReceiptRepository,
  AffairRepository,
  AuthenticationService,
  BlobStorage,
  FileMetadataStore,
  IdempotencyStore,
} from "@server-foundation/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Logger } from "./logger.js";

type AffairReceiptEnv = {
  Variables: {
    requestId: string;
    identity: AuthIdentity | undefined;
  };
};

type MountTarget = {
  route(path: string, app: Hono<AffairReceiptEnv>): unknown;
};

type Dependencies = {
  repository: AffairReceiptRepository;
  accessLog: AffairReceiptAccessLog;
  affairRepository: AffairRepository;
  fileMetadata: FileMetadataStore;
  blobStorage: BlobStorage;
  authenticationService?: AuthenticationService;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  allowUnauthenticated?: boolean;
  trustProxyHeaders?: boolean;
  logger?: Logger;
};

type RequestIdContext = {
  get(key: "requestId"): string;
  json: Context["json"];
};
type IdentityContext = { get(key: "identity"): AuthIdentity | undefined };

const defaultIdempotencyTtlSeconds = 86_400;
const pendingIdempotencyTtlSeconds = 300;
const idempotentMethods = new Set(["POST", "PATCH", "DELETE"]);
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

const bearerToken = (context: Context<AffairReceiptEnv>): string => {
  const authorization = context.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError();
  return token;
};

const canonicalApiPath = (path: string): string =>
  path.replace(/^\/api\/v1(?=\/|$)/, "/api");

const idempotencyKeyFor = (
  context: Context<AffairReceiptEnv>,
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
  context: Context<AffairReceiptEnv>,
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

const createAffairReceiptRouter = (dependencies: Dependencies) => {
  const api = new Hono<AffairReceiptEnv>();
  const service = new AffairReceiptService(
    dependencies.repository,
    dependencies.accessLog,
    dependencies.affairRepository,
    dependencies.fileMetadata,
    dependencies.blobStorage,
  );

  const authenticate = async (
    context: Context<AffairReceiptEnv>,
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
    context: Context<AffairReceiptEnv>,
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
      await store.release(scope, key, fingerprint).catch(() => undefined);
      throw error;
    }
  };

  api.use("/affair-receipts", authenticate);
  api.use("/affair-receipts/*", authenticate);
  api.use("/affair-receipts", enforceIdempotency);
  api.use("/affair-receipts/*", enforceIdempotency);

  const identityFor = (context: IdentityContext): AuthIdentity => {
    const identity = context.get("identity");
    if (!identity) throw new UnauthorizedError();
    return identity;
  };
  const scopeFor = (context: IdentityContext) => {
    const identity = identityFor(context);
    return { tenantId: identity.tenantId, actorUserId: identity.userId };
  };
  const fileScopeFor = (context: IdentityContext) => {
    const identity = identityFor(context);
    return {
      userId: identity.userId,
      tenantId: identity.tenantId,
      roles: identity.roles,
    };
  };
  const clientIp = (context: Context<AffairReceiptEnv>): string | null => {
    if (!dependencies.trustProxyHeaders) return null;
    const forwarded = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const real = context.req.header("x-real-ip")?.trim();
    const value = forwarded || real || null;
    return value && value.length <= 45 ? value : null;
  };
  const actorFor = (context: Context<AffairReceiptEnv>) => {
    const identity = identityFor(context);
    return {
      actorType: "backend" as const,
      actorUserId: identity.userId,
      actorAccount: null,
      ip: clientIp(context),
    };
  };

  api.get(
    "/affair-receipts",
    zValidator("query", AffairReceiptListQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid affair receipt query parameters.");
      }
    }),
    async (context) =>
      context.json(
        await service.listReceipts(
          context.req.valid("query"),
          actorFor(context),
          scopeFor(context),
        ),
      ),
  );

  api.post(
    "/affair-receipts/lookup-id-number",
    zValidator("json", AffairReceiptLookupSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid receipt ID-number lookup payload.");
      }
    }),
    async (context) =>
      context.json({
        item: await service.lookupByIdNumber(
          context.req.valid("json"),
          actorFor(context),
          scopeFor(context),
        ),
      }),
  );

  api.post(
    "/affair-receipts/print",
    zValidator("json", AffairReceiptSelectionSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid receipt print selection.");
      }
    }),
    async (context) =>
      context.json({
        items: await service.preparePrint(
          context.req.valid("json"),
          actorFor(context),
          scopeFor(context),
        ),
      }),
  );

  api.post(
    "/affair-receipts/export",
    zValidator("json", AffairReceiptSelectionSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid receipt export selection.");
      }
    }),
    async (context) =>
      context.json({
        items: await service.prepareExport(
          context.req.valid("json"),
          actorFor(context),
          scopeFor(context),
        ),
      }),
  );

  api.post(
    "/affair-receipts",
    zValidator("json", CreateAffairReceiptSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid affair receipt payload.");
      }
    }),
    async (context) =>
      context.json(
        await service.createReceipt(
          context.req.valid("json"),
          scopeFor(context),
          fileScopeFor(context),
        ),
        201,
      ),
  );

  api.get("/affair-receipts/:id/bankbook", async (context) => {
    const source = await service.getBankbookDownload(
      context.req.param("id"),
      actorFor(context),
      scopeFor(context),
      fileScopeFor(context),
    );
    return new Response(source.stream, {
      headers: {
        "Content-Type": source.mimeType,
        "Content-Length": String(source.contentLength),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(source.fileName)}`,
        "Cache-Control": "private, no-store",
      },
    });
  });

  api.get("/affair-receipts/:id", async (context) =>
    context.json(
      await service.getReceipt(
        context.req.param("id"),
        actorFor(context),
        scopeFor(context),
      ),
    ),
  );

  api.patch(
    "/affair-receipts/:id",
    zValidator("json", UpdateAffairReceiptSchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "Invalid affair receipt update payload.");
      }
    }),
    async (context) =>
      context.json(
        await service.updateReceipt(
          context.req.param("id"),
          context.req.valid("json"),
          scopeFor(context),
          fileScopeFor(context),
        ),
      ),
  );

  api.delete(
    "/affair-receipts/:id",
    zValidator("query", DeleteAffairReceiptQuerySchema, (result, context) => {
      if (!result.success) {
        return validationError(context, "A valid receipt version is required.");
      }
    }),
    async (context) => {
      await service.deleteReceipt(
        context.req.param("id"),
        context.req.valid("query").version,
        actorFor(context),
        scopeFor(context),
        fileScopeFor(context),
      );
      return context.body(null, 204);
    },
  );

  return api;
};

export const mountAffairReceiptRoutes = (
  app: MountTarget,
  dependencies: Dependencies,
): void => {
  app.route(LEGACY_API_PREFIX, createAffairReceiptRouter(dependencies));
  app.route(API_VERSION_PREFIX, createAffairReceiptRouter(dependencies));
};
