import {
  argon2id,
  hash as argon2Hash,
  verify as argon2Verify,
  type HashOptions,
} from "argon2";

export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} satisfies HashOptions & {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
});

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 128;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function validateUsername(value: string): string {
  const normalized = normalizeUsername(value);

  if (!USERNAME_PATTERN.test(normalized)) {
    throw new Error(
      "Username must be 3-64 lowercase letters, digits, dots, underscores, or hyphens and start with a letter or digit.",
    );
  }

  return normalized;
}

export function validatePassword(value: string): string {
  const byteLength = Buffer.byteLength(value, "utf8");
  const characterLength = Array.from(value).length;

  if (
    characterLength < MIN_PASSWORD_LENGTH ||
    byteLength > MAX_PASSWORD_BYTES
  ) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} UTF-8 bytes.`,
    );
  }

  return value;
}

export function createArgon2PasswordHasher(): PasswordHasher {
  return {
    hash: (password) =>
      argon2Hash(validatePassword(password), ARGON2ID_OPTIONS),
    verify: async (passwordHash, password) => {
      try {
        return await argon2Verify(passwordHash, password);
      } catch {
        return false;
      }
    },
  };
}
