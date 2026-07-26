import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { UserRepository } from "../users/userRepository";
import type {
  ActiveNativeSession,
  SessionRepository,
  SessionUser,
} from "./sessionRepository";
import {
  normalizeUsername,
  validateUsername,
  type PasswordHasher,
} from "./passwords";

const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_ABSOLUTE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_IDLE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_DEVICE_DESCRIPTION_LENGTH = 200;

export interface NativeUserDto {
  id: string;
  username: string;
  displayName: string;
  isAdministrator: boolean;
}

export interface NativeSessionResult {
  token: string;
  sessionId: string;
  expiresAt: Date;
  user: NativeUserDto;
}

export interface NativeAuthenticatedSession {
  sessionId: string;
  familyId: string;
  token: string;
  tokenHash: Buffer;
  expiresAt: Date;
  user: NativeUserDto;
}

export class NativeAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "NativeAuthError";
  }
}

export interface NativeAuthService {
  login(input: {
    username: string;
    password: string;
    deviceDescription?: string;
  }): Promise<NativeSessionResult>;
  getCurrentSession(token: string): Promise<NativeAuthenticatedSession>;
  refresh(token: string): Promise<NativeSessionResult>;
  logout(token: string | undefined): Promise<void>;
  logoutAll(token: string): Promise<void>;
  cleanupExpiredSessions(): Promise<number>;
}

export interface CreateNativeAuthServiceOptions {
  users: UserRepository;
  sessions: SessionRepository;
  passwords: PasswordHasher;
  sessionHashSecret: string;
  absoluteSessionTtlMs?: number;
  idleSessionTtlMs?: number;
  now?: () => Date;
  tokenFactory?: () => string;
  idFactory?: () => string;
}

export function hashSessionToken(token: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update("seyirlik-session-token\0")
    .update(token)
    .digest();
}

function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

function safeUser(user: SessionUser): NativeUserDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isAdministrator: user.isAdministrator,
  };
}

function invalidCredentials(): NativeAuthError {
  return new NativeAuthError(
    "INVALID_CREDENTIALS",
    "The username or password is invalid.",
    401,
  );
}

function authenticationRequired(): NativeAuthError {
  return new NativeAuthError(
    "AUTH_REQUIRED",
    "Authentication is required.",
    401,
  );
}

function boundedDeviceDescription(
  value: string | undefined,
): string | undefined {
  const normalized = value?.normalize("NFKC").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, MAX_DEVICE_DESCRIPTION_LENGTH);
}

function assertSessionToken(token: string): void {
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    throw authenticationRequired();
  }
}

function sessionResult(
  token: string,
  session: ActiveNativeSession,
): NativeSessionResult {
  return {
    token,
    sessionId: session.sessionId,
    expiresAt: session.absoluteExpiresAt,
    user: safeUser(session.user),
  };
}

export async function createNativeAuthService({
  users,
  sessions,
  passwords,
  sessionHashSecret,
  absoluteSessionTtlMs = DEFAULT_ABSOLUTE_SESSION_TTL_MS,
  idleSessionTtlMs = DEFAULT_IDLE_SESSION_TTL_MS,
  now = () => new Date(),
  tokenFactory = newSessionToken,
  idFactory = randomUUID,
}: CreateNativeAuthServiceOptions): Promise<NativeAuthService> {
  if (Buffer.byteLength(sessionHashSecret, "utf8") < 32) {
    throw new Error("SEYIRLIK_SESSION_HASH_SECRET must be at least 32 bytes.");
  }
  if (
    !Number.isSafeInteger(absoluteSessionTtlMs) ||
    absoluteSessionTtlMs <= 0 ||
    !Number.isSafeInteger(idleSessionTtlMs) ||
    idleSessionTtlMs <= 0 ||
    idleSessionTtlMs > absoluteSessionTtlMs
  ) {
    throw new Error("Native session expiration configuration is invalid.");
  }

  const dummyPasswordHash = await passwords.hash(
    "invalid credential timing placeholder",
  );

  const hashToken = (token: string) =>
    hashSessionToken(token, sessionHashSecret);
  const idleExpiry = (at: Date) => new Date(at.getTime() + idleSessionTtlMs);

  const getCurrentSession = async (
    token: string,
  ): Promise<NativeAuthenticatedSession> => {
    assertSessionToken(token);
    const checkedAt = now();
    const tokenHash = hashToken(token);
    const session = await sessions.findAndTouchActive(
      tokenHash,
      checkedAt,
      idleExpiry(checkedAt),
    );

    if (!session) {
      throw authenticationRequired();
    }

    return {
      sessionId: session.sessionId,
      familyId: session.familyId,
      token,
      tokenHash,
      expiresAt: session.absoluteExpiresAt,
      user: safeUser(session.user),
    };
  };

  return {
    async login(input) {
      let normalizedUsername: string | null = null;
      try {
        normalizedUsername = validateUsername(input.username);
      } catch {
        normalizedUsername = null;
      }

      const user = normalizedUsername
        ? await users.findByNormalizedUsername(normalizedUsername)
        : null;
      const boundedPassword =
        Buffer.byteLength(input.password, "utf8") <= 256
          ? input.password
          : "invalid credential timing placeholder";
      const verified = await passwords.verify(
        user?.passwordHash ?? dummyPasswordHash,
        boundedPassword,
      );

      if (!user || !verified || user.isDisabled) {
        throw invalidCredentials();
      }

      const issuedAt = now();
      const token = tokenFactory();
      assertSessionToken(token);
      const session = await sessions.create({
        id: idFactory(),
        userId: user.id,
        tokenHash: hashToken(token),
        familyId: idFactory(),
        createdAt: issuedAt,
        absoluteExpiresAt: new Date(issuedAt.getTime() + absoluteSessionTtlMs),
        idleExpiresAt: idleExpiry(issuedAt),
        deviceDescription: boundedDeviceDescription(input.deviceDescription),
      });
      await users.recordSuccessfulLogin(user.id, issuedAt);
      return sessionResult(token, session);
    },

    getCurrentSession,

    async refresh(token) {
      assertSessionToken(token);
      const refreshedAt = now();
      const newToken = tokenFactory();
      assertSessionToken(newToken);
      const result = await sessions.rotate({
        previousTokenHash: hashToken(token),
        newSessionId: idFactory(),
        newTokenHash: hashToken(newToken),
        now: refreshedAt,
        idleExpiresAt: idleExpiry(refreshedAt),
      });

      if (result.status === "reused") {
        throw new NativeAuthError(
          "SESSION_TOKEN_REUSED",
          "The session can no longer be refreshed.",
          401,
        );
      }
      if (result.status === "invalid") {
        throw authenticationRequired();
      }
      return sessionResult(newToken, result.session);
    },

    async logout(token) {
      if (!token || !SESSION_TOKEN_PATTERN.test(token)) {
        return;
      }
      await sessions.revokeFamilyByTokenHash(hashToken(token), now());
    },

    async logoutAll(token) {
      const current = await getCurrentSession(token);
      await sessions.revokeAllForUser(current.user.id, now());
    },

    cleanupExpiredSessions: () => sessions.cleanupExpired(now()),
  };
}

export function normalizeLoginUsername(value: string): string {
  return normalizeUsername(value);
}
