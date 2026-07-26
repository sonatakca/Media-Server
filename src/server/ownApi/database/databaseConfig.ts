export type IdentityProvider = "jellyfin" | "native";

export interface DatabaseConfig {
  connectionString: string;
  maxConnections: number;
}

type Environment = Record<string, string | undefined>;

const DEFAULT_POOL_MAX = 10;
const MAX_POOL_SIZE = 20;

export function parseIdentityProvider(
  value: string | undefined,
): IdentityProvider {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return "jellyfin";
  }

  if (normalized === "jellyfin" || normalized === "native") {
    return normalized;
  }

  throw new Error(
    "SEYIRLIK_IDENTITY_PROVIDER must be either jellyfin or native.",
  );
}

function parsePoolSize(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_POOL_MAX;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_POOL_SIZE) {
    throw new Error(
      `SEYIRLIK_DATABASE_POOL_MAX must be an integer between 1 and ${MAX_POOL_SIZE}.`,
    );
  }

  return parsed;
}

function validatePostgresUrl(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use PostgreSQL.");
  }

  return value;
}

export function parseDatabaseConfig(
  environment: Environment = process.env,
): DatabaseConfig | null {
  const provider = parseIdentityProvider(
    environment.SEYIRLIK_IDENTITY_PROVIDER,
  );

  if (provider !== "native") {
    return null;
  }

  const connectionString = environment.DATABASE_URL?.trim();

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required when native identity is enabled.",
    );
  }

  return {
    connectionString: validatePostgresUrl(connectionString),
    maxConnections: parsePoolSize(environment.SEYIRLIK_DATABASE_POOL_MAX),
  };
}
