import type {
  AuthIdentity,
  AuthTokenResponse,
  LoginRequest,
} from "@server-foundation/api-contracts";

export type UserRecord = AuthIdentity & {
  passwordHash: string;
  disabledAt: string | null;
};

export type NewUser = AuthIdentity & {
  passwordHash: string;
};

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  create(user: NewUser): Promise<UserRecord>;
}

export type AuthSession = {
  sessionId: string;
  identity: AuthIdentity;
  currentAccessTokenHash: string;
  createdAt: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
};

export type CreateSessionInput = AuthSession & {
  accessTokenHash: string;
  refreshTokenHash: string;
};

export type RotateSessionInput = {
  refreshTokenHash: string;
  newAccessTokenHash: string;
  newAccessTokenTtlSeconds: number;
  newAccessTokenExpiresAt: string;
  newRefreshTokenHash: string;
};

export interface SessionStore {
  create(input: CreateSessionInput): Promise<void>;
  findByAccessTokenHash(accessTokenHash: string): Promise<AuthSession | null>;
  rotate(input: RotateSessionInput): Promise<AuthSession | null>;
  revokeByAccessTokenHash(accessTokenHash: string): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string): Promise<boolean>;
}

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface RateLimiter {
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

export interface AuthenticationService {
  login(input: LoginRequest): Promise<AuthTokenResponse>;
  refresh(refreshToken: string): Promise<AuthTokenResponse>;
  authenticate(accessToken: string): Promise<AuthIdentity>;
  logout(accessToken: string): Promise<void>;
}
