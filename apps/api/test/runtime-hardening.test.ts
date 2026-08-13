import { describe, expect, it } from "vitest";
import type {
  AuthIdentity,
  AuthTokenResponse,
  FileMetadata,
  LoginRequest,
} from "@server-foundation/api-contracts";
import type {
  AuthenticationService,
  BlobStorage,
  RateLimiter,
  RateLimitResult,
} from "@server-foundation/domain";
import { createInMemoryItemRepository } from "@server-foundation/testing";
import { createApp } from "../src/app.js";

const identity: AuthIdentity = {
  userId: "user-1",
  email: "user@example.com",
  tenantId: "tenant-1",
  roles: ["member"],
};

const tokens: AuthTokenResponse = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
  refreshTokenExpiresAt: "2030-02-01T00:00:00.000Z",
};

class FakeAuthenticationService implements AuthenticationService {
  async login(_input: LoginRequest): Promise<AuthTokenResponse> {
    return tokens;
  }

  async refresh(_refreshToken: string): Promise<AuthTokenResponse> {
    return tokens;
  }

  async authenticate(_accessToken: string): Promise<AuthIdentity> {
    return identity;
  }

  async logout(_accessToken: string): Promise<void> {}
}

class CountingRateLimiter implements RateLimiter {
  readonly keys: string[] = [];
  private readonly counts = new Map<string, number>();

  async consume(
    key: string,
    limit: number,
    _windowSeconds: number,
  ): Promise<RateLimitResult> {
    this.keys.push(key);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { allowed: count <= limit, retryAfterSeconds: 30 };
  }
}

const loginRequest = (email: string, forwardedFor = "203.0.113.10") => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-forwarded-for": forwardedFor,
  },
  body: JSON.stringify({ email, password: "correct-password" }),
});

describe("runtime hardening", () => {
  it("rate-limits login attempts by trusted client IP across accounts", async () => {
    const limiter = new CountingRateLimiter();
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      authenticationService: new FakeAuthenticationService(),
      loginIpRateLimiter: limiter,
      loginIpRateLimit: { limit: 2, windowSeconds: 60 },
      trustProxyHeaders: true,
    });

    expect(
      (await app.request("/api/auth/login", loginRequest("a@example.com")))
        .status,
    ).toBe(200);
    expect(
      (await app.request("/api/auth/login", loginRequest("b@example.com")))
        .status,
    ).toBe(200);
    const limited = await app.request(
      "/api/auth/login",
      loginRequest("c@example.com"),
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(limiter.keys).toEqual([
      "auth:login:ip:203.0.113.10",
      "auth:login:ip:203.0.113.10",
      "auth:login:ip:203.0.113.10",
    ]);
  });

  it("does not trust forwarded client IP headers unless explicitly enabled", async () => {
    const limiter = new CountingRateLimiter();
    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      authenticationService: new FakeAuthenticationService(),
      loginIpRateLimiter: limiter,
      loginIpRateLimit: { limit: 1, windowSeconds: 60 },
    });

    expect(
      (await app.request("/api/auth/login", loginRequest("a@example.com")))
        .status,
    ).toBe(200);
    expect(
      (await app.request("/api/auth/login", loginRequest("b@example.com")))
        .status,
    ).toBe(200);
    expect(limiter.keys).toEqual([]);
  });

  it("rejects concurrent mutations of the same upload session", async () => {
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let writeCalls = 0;

    const storage: BlobStorage = {
      async initiateUpload() {
        return {
          sessionId: "session-a",
          fileId: "file-a",
          expiresAt: "2030-01-01T00:00:00.000Z",
          resumable: false,
        };
      },
      async writeUpload() {
        writeCalls += 1;
        if (writeCalls === 1) {
          markStarted?.();
          await firstPending;
        }
        return { bytesReceived: 1, complete: true };
      },
      async completeUpload(): Promise<FileMetadata> {
        throw new Error("not used");
      },
      async cancelUpload() {},
      async getDownload() {
        throw new Error("not used");
      },
      async delete() {},
    };

    const app = createApp({
      itemRepository: createInMemoryItemRepository(),
      blobStorage: storage,
      allowUnauthenticatedItems: true,
    });

    const upload = () =>
      app.request("/api/files/upload-sessions/session-a/content", {
        method: "PUT",
        body: new Uint8Array([1]),
      });

    const first = upload();
    await started;
    const second = await upload();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: { code: "conflict" },
    });

    releaseFirst?.();
    expect((await first).status).toBe(200);
    expect((await upload()).status).toBe(200);
    expect(writeCalls).toBe(2);
  });
});
