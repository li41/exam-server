import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AuthIdentity,
  AuthTokenResponse,
  LoginRequest,
} from "@server-foundation/api-contracts";
import {
  UnauthorizedError,
  RateLimitedError,
  type AuthenticationService,
  type PasswordHasher,
  type RateLimiter,
  type SessionStore,
  type UserRecord,
  type UserRepository,
} from "@server-foundation/domain";

const defaultAccessTokenTtlSeconds = 15 * 60;
const defaultRefreshTokenTtlSeconds = 30 * 24 * 60 * 60;

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("base64url");

const createToken = (): string => randomBytes(32).toString("base64url");

const addSeconds = (date: Date, seconds: number): string =>
  new Date(date.getTime() + seconds * 1000).toISOString();

const toIdentity = (user: UserRecord): AuthIdentity => ({
  userId: user.userId,
  email: user.email,
  tenantId: user.tenantId,
  roles: [...user.roles],
});

export type AuthServiceOptions = {
  users: UserRepository;
  sessions: SessionStore;
  passwordHasher: PasswordHasher;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  rateLimiter?: RateLimiter;
  loginRateLimit?: { limit: number; windowSeconds: number };
  now?: () => Date;
};

export class AuthService implements AuthenticationService {
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;
  private readonly now: () => Date;

  constructor(private readonly options: AuthServiceOptions) {
    this.accessTokenTtlSeconds =
      options.accessTokenTtlSeconds ?? defaultAccessTokenTtlSeconds;
    this.refreshTokenTtlSeconds =
      options.refreshTokenTtlSeconds ?? defaultRefreshTokenTtlSeconds;
    this.now = options.now ?? (() => new Date());
  }

  async login(input: LoginRequest): Promise<AuthTokenResponse> {
    const email = input.email.trim().toLowerCase();
    const rateLimit = this.options.rateLimiter;
    if (rateLimit) {
      const policy = this.options.loginRateLimit ?? {
        limit: 5,
        windowSeconds: 60,
      };
      const result = await rateLimit.consume(
        `auth:login:${email}`,
        policy.limit,
        policy.windowSeconds,
      );
      if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
    }
    const user = await this.options.users.findByEmail(email);
    const valid =
      user !== null &&
      user.disabledAt === null &&
      (await this.options.passwordHasher.verify(
        input.password,
        user.passwordHash,
      ));

    if (!valid || !user) {
      throw new UnauthorizedError("Invalid email or password.");
    }

    return this.createSession(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokenResponse> {
    const accessToken = createToken();
    const newRefreshToken = createToken();
    const now = this.now();
    const accessTokenExpiresAt = addSeconds(now, this.accessTokenTtlSeconds);
    const session = await this.options.sessions.rotate({
      refreshTokenHash: hashToken(refreshToken),
      newAccessTokenHash: hashToken(accessToken),
      newAccessTokenTtlSeconds: this.accessTokenTtlSeconds,
      newAccessTokenExpiresAt: accessTokenExpiresAt,
      newRefreshTokenHash: hashToken(newRefreshToken),
    });

    if (!session)
      throw new UnauthorizedError("Invalid or expired refresh token.");

    return {
      accessToken,
      refreshToken: newRefreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    };
  }

  async authenticate(accessToken: string): Promise<AuthIdentity> {
    const session = await this.options.sessions.findByAccessTokenHash(
      hashToken(accessToken),
    );
    if (!session || new Date(session.accessTokenExpiresAt) <= this.now()) {
      throw new UnauthorizedError();
    }
    return session.identity;
  }

  async logout(accessToken: string): Promise<void> {
    await this.options.sessions.revokeByAccessTokenHash(hashToken(accessToken));
  }

  private async createSession(user: UserRecord): Promise<AuthTokenResponse> {
    const accessToken = createToken();
    const refreshToken = createToken();
    const now = this.now();
    const session = {
      sessionId: randomUUID(),
      identity: toIdentity(user),
      currentAccessTokenHash: hashToken(accessToken),
      createdAt: now.toISOString(),
      accessTokenExpiresAt: addSeconds(now, this.accessTokenTtlSeconds),
      refreshTokenExpiresAt: addSeconds(now, this.refreshTokenTtlSeconds),
    };

    await this.options.sessions.create({
      ...session,
      accessTokenHash: session.currentAccessTokenHash,
      refreshTokenHash: hashToken(refreshToken),
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    };
  }
}
