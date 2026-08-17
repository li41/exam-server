import { createHash } from "node:crypto";
import type { AuthIdentity } from "@server-foundation/api-contracts";
import {
  API_VERSION,
  API_VERSION_PREFIX,
  LEGACY_API_PREFIX,
} from "@server-foundation/api-contracts";
import {
  CapabilityMissingError,
  CompanyMemberService,
  ConflictError,
  DomainError,
  UnauthorizedError,
  parseCompanyMemberListQuery,
  parseCreateCompanyMemberInput,
  parseUpdateCompanyMemberInput,
} from "@server-foundation/domain";
import type {
  AuthenticationService,
  CompanyMemberRepository,
  CompanyMemberScope,
  IdempotencyStore,
} from "@server-foundation/domain";
import { Hono } from "hono";
import type { Context } from "hono";

type CompanyMemberEnv = {
  Variables: {
    requestId: string;
    identity: AuthIdentity | undefined;
  };
};

type MountTarget = {
  route(path: string, app: Hono<CompanyMemberEnv>): unknown;
};

type Dependencies = {
  repository: CompanyMemberRepository;
  authenticationService?: AuthenticationService;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  allowUnauthenticated?: boolean;
};

const localDevelopmentIdentity: AuthIdentity = {
  userId: "local-development-user",
  email: "local-development@example.invalid",
  tenantId: "local-development-tenant",
  roles: ["developer"],
};
const defaultIdempotencyTtlSeconds = 86_400;
const pendingIdempotencyTtlSeconds = 300;

const bearerToken = (context: Context<CompanyMemberEnv>): string => {
  const authorization = context.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError();
  return token;
};

const canonicalApiPath = (path: string): string =>
  path.replace(/^\/api\/v1(?=\/|$)/, "/api");

const readJson = async (
  context: Context<CompanyMemberEnv>,
): Promise<unknown> => {
  try {
    return await context.req.json();
  } catch {
    throw new DomainError("validation_error", "Invalid JSON payload.");
  }
};

const idempotencyKeyFor = (
  context: Context<CompanyMemberEnv>,
): string | undefined => {
  const raw = context.req.header("idempotency-key") as string | undefined;
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

const createRouter = (dependencies: Dependencies) => {
  const api = new Hono<CompanyMemberEnv>();
  const service = new CompanyMemberService(dependencies.repository);

  const authenticate = async (
    context: Context<CompanyMemberEnv>,
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

  const scopeFor = (context: Context<CompanyMemberEnv>): CompanyMemberScope => {
    const identity = context.get("identity");
    if (!identity) throw new UnauthorizedError();
    return { tenantId: identity.tenantId, actorUserId: identity.userId };
  };

  const enforceIdempotency = async (
    context: Context<CompanyMemberEnv>,
    next: () => Promise<void>,
  ) => {
    if (context.req.method !== "POST" && context.req.method !== "PATCH") {
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
    const path = canonicalApiPath(url.pathname);
    const scope = `${identity.tenantId}:${context.req.method}:${path}`;
    const hash = createHash("sha256");
    hash.update(context.req.method);
    hash.update("\n");
    hash.update(`${path}${url.search}`);
    hash.update("\n");
    if (context.req.raw.body) {
      hash.update(Buffer.from(await context.req.raw.clone().arrayBuffer()));
    }
    const fingerprint = hash.digest("hex");
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
        );
      } else {
        await store.release(scope, key, fingerprint);
      }
    } catch (error) {
      await store.release(scope, key, fingerprint).catch(() => undefined);
      throw error;
    }
  };

  for (const path of ["/company-members", "/company-members/*"]) {
    api.use(path, authenticate);
    api.use(path, enforceIdempotency);
  }

  api.get("/company-members", async (context) =>
    context.json(
      await service.list(
        parseCompanyMemberListQuery(context.req.query()),
        scopeFor(context),
      ),
    ),
  );

  api.get("/company-members/:id", async (context) =>
    context.json(await service.get(context.req.param("id"), scopeFor(context))),
  );

  api.post("/company-members", async (context) =>
    context.json(
      await service.create(
        parseCreateCompanyMemberInput(await readJson(context)),
        scopeFor(context),
      ),
      201,
    ),
  );

  api.patch("/company-members/:id", async (context) =>
    context.json(
      await service.update(
        context.req.param("id"),
        parseUpdateCompanyMemberInput(await readJson(context)),
        scopeFor(context),
      ),
    ),
  );

  return api;
};

export const mountCompanyMemberRoutes = (
  app: MountTarget,
  dependencies: Dependencies,
): void => {
  app.route(LEGACY_API_PREFIX, createRouter(dependencies));
  app.route(API_VERSION_PREFIX, createRouter(dependencies));
};
