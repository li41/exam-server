import { describe, expect, it } from "vitest";
import type {
  AuthIdentity,
  LoginRequest,
} from "@server-foundation/api-contracts";
import { AuthService, type PasswordHasher } from "../src/index.js";
import type {
  AuthSession,
  CreateSessionInput,
  NewUser,
  RotateSessionInput,
  SessionStore,
  UserRecord,
  UserRepository,
} from "@server-foundation/domain";

const identity: AuthIdentity = {
  userId: "user-1",
  email: "user@example.com",
  tenantId: "tenant-1",
  roles: ["member"],
};

class FakeHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  async verify(password: string, passwordHash: string): Promise<boolean> {
    return passwordHash === `hash:${password}`;
  }
}

class FakeUsers implements UserRepository {
  private readonly user: UserRecord = {
    ...identity,
    passwordHash: "hash:correct",
    disabledAt: null,
  };

  async findByEmail(email: string): Promise<UserRecord | null> {
    return email === this.user.email ? this.user : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    return { ...user, disabledAt: null };
  }
}

class FakeSessions implements SessionStore {
  private current: {
    session: AuthSession;
    accessTokenHash: string;
    refreshTokenHash: string;
    revoked: boolean;
  } | null = null;

  async create(input: CreateSessionInput): Promise<void> {
    this.current = {
      session: {
        sessionId: input.sessionId,
        identity: input.identity,
        currentAccessTokenHash: input.accessTokenHash,
        createdAt: input.createdAt,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      },
      accessTokenHash: input.accessTokenHash,
      refreshTokenHash: input.refreshTokenHash,
      revoked: false,
    };
  }

  async findByAccessTokenHash(hash: string): Promise<AuthSession | null> {
    if (!this.current || this.current.revoked) return null;
    return this.current.accessTokenHash === hash ? this.current.session : null;
  }

  async rotate(input: RotateSessionInput): Promise<AuthSession | null> {
    if (
      !this.current ||
      this.current.revoked ||
      this.current.refreshTokenHash !== input.refreshTokenHash
    ) {
      return null;
    }
    this.current.refreshTokenHash = input.newRefreshTokenHash;
    this.current.accessTokenHash = input.newAccessTokenHash;
    this.current.session = {
      ...this.current.session,
      currentAccessTokenHash: input.newAccessTokenHash,
      accessTokenExpiresAt: input.newAccessTokenExpiresAt,
    };
    return this.current.session;
  }

  async revokeByAccessTokenHash(hash: string): Promise<void> {
    if (this.current?.accessTokenHash === hash) this.current.revoked = true;
  }
}

const createService = () =>
  new AuthService({
    users: new FakeUsers(),
    sessions: new FakeSessions(),
    passwordHasher: new FakeHasher(),
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 3600,
  });

const loginInput: LoginRequest = {
  email: " USER@example.com ",
  password: "correct",
};

describe("AuthService", () => {
  it("normalizes email and authenticates an issued access token", async () => {
    const service = createService();
    const tokens = await service.login(loginInput);

    expect((await service.authenticate(tokens.accessToken)).userId).toBe(
      identity.userId,
    );
  });

  it("rotates refresh tokens and rejects reuse of the old token", async () => {
    const service = createService();
    const first = await service.login(loginInput);
    const second = await service.refresh(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(service.refresh(first.refreshToken)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      service.authenticate(second.accessToken),
    ).resolves.toMatchObject(identity);
  });

  it("revokes the session on logout", async () => {
    const service = createService();
    const tokens = await service.login(loginInput);
    await service.logout(tokens.accessToken);

    await expect(
      service.authenticate(tokens.accessToken),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});
