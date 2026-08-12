import { OwnApiError } from "../ownApiHandler";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "./envelope";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validationError(message: string): OwnApiError {
  return new OwnApiError("VALIDATION_FAILED", message, 422);
}

export function requireUuid(value: string | undefined, field: string): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw validationError(`The ${field} is invalid.`);
  }
  return value.toLowerCase();
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseLimit(
  raw: string | null,
  max = MAX_PAGE_LIMIT,
  fallback = DEFAULT_PAGE_LIMIT,
): number {
  if (raw === null || raw === "") return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw validationError(`limit must be an integer between 1 and ${max}.`);
  }
  return limit;
}

export function parseEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
  field: string,
): T {
  if (raw === null || raw === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw validationError(`${field} is invalid.`);
  }
  return raw as T;
}

export function parseOptionalEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (raw === null || raw === "") return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw validationError(`${field} is invalid.`);
  }
  return raw as T;
}

export function parseOptionalUuid(
  raw: string | null,
  field: string,
): string | undefined {
  if (raw === null || raw === "") return undefined;
  return requireUuid(raw, field);
}

export function parseSearchQuery(raw: string | null): string {
  const query = (raw ?? "").trim();
  if (!query) {
    throw validationError("q must not be empty.");
  }
  if (query.length > 200) {
    throw validationError("q is too long.");
  }
  return query;
}

export function parseOptionalBoolean(
  raw: string | null,
  field: string,
): boolean | undefined {
  if (raw === null || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw validationError(`${field} must be true or false.`);
}

export function parseOptionalNonNegativeInteger(
  raw: string | null,
  field: string,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw validationError(`${field} is invalid.`);
  }
  return value;
}

/**
 * Rejects unknown keys rather than ignoring them: a typo in a client field name
 * should surface as a validation failure, not as a silently discarded update.
 */
export function asObjectBody(
  value: unknown,
  allowedKeys: readonly string[],
  message = "The request body is invalid.",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(message);
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw validationError(message);
  }
  return candidate;
}

export function requireBodyString(
  body: Record<string, unknown>,
  field: string,
  {
    maxLength = 500,
    minLength = 1,
  }: { maxLength?: number; minLength?: number } = {},
): string {
  const value = body[field];
  if (
    typeof value !== "string" ||
    value.length < minLength ||
    value.length > maxLength
  ) {
    throw validationError(`${field} is invalid.`);
  }
  return value;
}

export function optionalBodyString(
  body: Record<string, unknown>,
  field: string,
  { maxLength = 500 }: { maxLength?: number } = {},
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw validationError(`${field} is invalid.`);
  }
  return value;
}

export function optionalBodyBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw validationError(`${field} is invalid.`);
  }
  return value;
}

export function optionalBodyInteger(
  body: Record<string, unknown>,
  field: string,
  {
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
  }: { min?: number; max?: number } = {},
): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw validationError(`${field} is invalid.`);
  }
  return value as number;
}

export function requireBodyInteger(
  body: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = optionalBodyInteger(body, field, options);
  if (value === undefined) {
    throw validationError(`${field} is required.`);
  }
  return value;
}

export function optionalBodyStringArray(
  body: Record<string, unknown>,
  field: string,
  {
    maxItems = 100,
    maxLength = 200,
  }: { maxItems?: number; maxLength?: number } = {},
): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length < 1 ||
        entry.length > maxLength,
    )
  ) {
    throw validationError(`${field} is invalid.`);
  }
  return value as string[];
}
