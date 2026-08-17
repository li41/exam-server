import { createHash } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  API_VERSION,
  API_VERSION_PREFIX,
  AffairListQuerySchema,
  AffairSchoolListQuerySchema,
  CreateAffairSchema,
  CreateAffairSchoolSchema,
  DeleteAffairSchoolQuerySchema,
  LEGACY_API_PREFIX,
  UpdateAffairCitySchema,
  UpdateAffairSchema,
  UpdateAffairSchoolSchema,
} from "@server-foundation/api-contracts";
import type { AuthIdentity } from "@server-foundation/api-contracts";
import {
  AffairService,
  CapabilityMissingError,
  ConflictError,
  DomainError,
  UnauthorizedError,
} from "@server-foundation/domain";
import type {
  AffairRepository,
  AuthenticationService,
  IdempotencyStore,
} from "@server-foundation/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Logger } from "./logger.js";

type AffairEnv = {
  Variables: {
    requestId: string;
    identity: AuthIdentity | undefined;
  };
};
type MountTarget = { route(path: string, app: Hono<AffairEnv>): unknown };
type Dependencies = {
  repository: AffairRepository;
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
const idempotentMethods = new Set(["POST", "PATCH", "DELETE"]);
const localDevelopmentIdentity: AuthIdentity = {
  userId: "local-development-user",
  email: "local-development@example.invalid",
  tenantId: "local-development-tenant",
  roles: ["developer"],
};

const validationError = (context: RequestIdContext, message: string) =>
  context.json(
    { error: { code: "validation_error" as const, message }, requestId: context.get("requestId") },
    400,
  );
const bearerToken = (context: Context<AffairEnv>): string => {
  const authorization = context.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError();
  return token;
};
const canonicalApiPath = (path: string): string => path.replace(/^\/api\/v1(?=\/|$)/, "/api");
const idempotencyKeyFor = (context: Context<AffairEnv>): string | undefined => {
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
const requestFingerprint = async (context: Context<AffairEnv>): Promise<string> => {
  const url = new URL(context.req.url);
  const hash = createHash("sha256");
  hash.update(context.req.method);
  hash.update("\n");
  hash.update(`${canonicalApiPath(url.pathname)}${url.search}`);
  hash.update("\n");
  if (context.req.raw.body) hash.update(Buffer.from(await context.req.raw.clone().arrayBuffer()));
  return hash.digest("hex");
};

const createAffairRouter = (dependencies: Dependencies) => {
  const api = new Hono<AffairEnv>();
  const service = new AffairService(dependencies.repository);

  const authenticate = async (context: Context<AffairEnv>, next: () => Promise<void>) => {
    if (dependencies.authenticationService) {
      context.set("identity", await dependencies.authenticationService.authenticate(bearerToken(context)));
    } else if (dependencies.allowUnauthenticated) {
      context.set("identity", localDevelopmentIdentity);
    } else {
      throw new CapabilityMissingError("authentication");
    }
    await next();
  };

  const enforceIdempotency = async (context: Context<AffairEnv>, next: () => Promise<void>) => {
    if (!idempotentMethods.has(context.req.method)) { await next(); return; }
    const key = idempotencyKeyFor(context);
    if (!key) { await next(); return; }
    const store = dependencies.idempotencyStore;
    if (!store) throw new CapabilityMissingError("idempotency storage");
    const identity = context.get("identity");
    if (!identity) throw new UnauthorizedError();
    const url = new URL(context.req.url);
    const canonicalPath = canonicalApiPath(url.pathname);
    const scope = `${identity.tenantId}:${context.req.method}:${canonicalPath}`;
    const fingerprint = await requestFingerprint(context);
    const ttlSeconds = dependencies.idempotencyTtlSeconds ?? defaultIdempotencyTtlSeconds;
    const reservation = await store.reserve(
      scope,
      key,
      fingerprint,
      Math.min(pendingIdempotencyTtlSeconds, ttlSeconds),
    );
    if (reservation.state === "conflict") throw new ConflictError("Idempotency-Key was already used with a different request.");
    if (reservation.state === "pending") throw new ConflictError("A request with this Idempotency-Key is already in progress.");
    if (reservation.state === "completed") {
      const headers = new Headers({
        "Idempotency-Key": key,
        "X-Idempotent-Replay": "true",
        "X-Request-Id": context.get("requestId"),
        "X-API-Version": API_VERSION,
      });
      if (url.pathname.startsWith(`${LEGACY_API_PREFIX}/`) && !url.pathname.startsWith(`${API_VERSION_PREFIX}/`)) {
        headers.set("X-API-Legacy-Route", "true");
      }
      if (reservation.response.contentType) headers.set("Content-Type", reservation.response.contentType);
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
        await store.complete(
          scope,
          key,
          fingerprint,
          {
            status: response.status,
            body: await response.text(),
            contentType: response.headers.get("content-type") ?? undefined,
          },
          ttlSeconds,
        ).catch((error: unknown) => {
          dependencies.logger?.error("idempotency_commit_failed", {
            requestId: context.get("requestId"),
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } else {
        await store.release(scope, key, fingerprint);
      }
    } catch (error) {
      await store.release(scope, key, fingerprint).catch((releaseError: unknown) => {
        dependencies.logger?.warn("idempotency_release_failed", {
          requestId: context.get("requestId"),
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      });
      throw error;
    }
  };

  for (const path of ["/affairs", "/affairs/*", "/affair-cities", "/affair-cities/*", "/affair-schools", "/affair-schools/*"]) {
    api.use(path, authenticate);
    api.use(path, enforceIdempotency);
  }

  const scopeFor = (context: IdentityContext) => {
    const identity = context.get("identity");
    if (!identity) throw new UnauthorizedError();
    return { tenantId: identity.tenantId, actorUserId: identity.userId };
  };

  api.get(
    "/affairs",
    zValidator("query", AffairListQuerySchema, (result, context) => {
      if (!result.success) return validationError(context, "Invalid affair query parameters.");
    }),
    async (context) => context.json(await service.listAffairs(context.req.valid("query"), scopeFor(context))),
  );
  api.get("/affairs/:id", async (context) => context.json(await service.getAffair(context.req.param("id"), scopeFor(context))));
  api.post(
    "/affairs",
    zValidator("json", CreateAffairSchema, (result, context) => {
      if (!result.success) return validationError(context, "Invalid affair payload.");
    }),
    async (context) => context.json(await service.createAffair(context.req.valid("json"), scopeFor(context)), 201),
  );
  api.patch(
    "/affairs/:id",
    zValidator("json", UpdateAffairSchema, (result, context) => {
      if (!result.success) return validationError(context, "Invalid affair payload.");
    }),
    async (context) => context.json(await service.updateAffair(context.req.param("id"), context.req.valid("json"), scopeFor(context))),
  );

  api.get("/affair-cities", async (context) => context.json(await service.listCities(scopeFor(context))));
  api.post("/affair-cities/initialize", async (context) => context.json(await service.initializeCities(scopeFor(context)), 201));
  api.patch(
    "/affair-cities/:id",
    zValidator("json", UpdateAffairCitySchema, (result, context) => {
      if (!result.success) return validationError(context, "Invalid affair city payload.");
    }),
    async (context) => context.json(await service.updateCity(context.req.param("id"), context.req.valid("json"), scopeFor(context))),
  );

  api.get(
    "/affair-schools",
    zValidator("query", AffairSchoolListQuerySchema, (result, context) => {
      if (!result.success) return validationError(context, "Invalid affair school query parameters.");
    }),
    async (context) => context.json(await service.listSchools(context.req.valid("query"), scopeFor(context))),
  );
  api.get("/affair-schools/:id", async (context) => context.json(await service.getSchool(context.req.param("id"), scopeFor(context))));
  api.post(
    "/affair-schools",
    zValidator("json", CreateAffairSchoolSchema, (result, context) => {
      if (!result.success) return validationError(context, "Invalid affair school payload.");
    }),
    async (context) => context.json(await service.createSchool(context.req.valid("json"), scopeFor(context)), 201),
  );
  api.patch(
    "/affair-schools/:id",
    zValidator("json", UpdateAffairSchoolSchema, (result, context) => {
      if (!result.success) return validationError(context, "Invalid affair school payload.");
    }),
    async (context) => context.json(await service.updateSchool(context.req.param("id"), context.req.valid("json"), scopeFor(context))),
  );
  api.delete(
    "/affair-schools/:id",
    zValidator("query", DeleteAffairSchoolQuerySchema, (result, context) => {
      if (!result.success) return validationError(context, "A valid version is required.");
    }),
    async (context) => {
      await service.deleteSchool(context.req.param("id"), context.req.valid("query").version, scopeFor(context));
      return context.body(null, 204);
    },
  );

  return api;
};

export const mountAffairRoutes = (app: MountTarget, dependencies: Dependencies): void => {
  app.route(LEGACY_API_PREFIX, createAffairRouter(dependencies));
  app.route(API_VERSION_PREFIX, createAffairRouter(dependencies));
};
