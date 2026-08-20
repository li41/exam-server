import type {
  AuthIdentity,
  AuthTokenResponse,
  LoginRequest,
} from "@server-foundation/api-contracts";

export type UserRecord = AuthIdentity & {
  passwordHash: string;
  disabledAt: string | null;
};

/**
 * `displayName` 只在**建立帳號時**寫入，⛔ 不進 `AuthIdentity`：
 * 它不是授權資訊，只是題目「建立者」那一格要顯示的姓名（`#98` A-6）。
 * 讀取路徑是題庫查詢的 `LEFT JOIN users`，與 PHP 同形
 * （`exam.tw/src/Models/Question.php:899-906`）。
 */
export type NewUser = AuthIdentity & {
  passwordHash: string;
  displayName?: string | null;
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
