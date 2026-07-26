import { parseIdentityProvider } from "../database/databaseConfig";

export interface NativeAuthConfig {
  sessionHashSecret: string;
  csrfSecret: string;
  secureCookies: boolean;
  sessionCookieName: string;
  csrfCookieName: string;
}

type Environment = Record<string, string | undefined>;

function requiredSecret(
  environment: Environment,
  name: "SEYIRLIK_SESSION_HASH_SECRET" | "SEYIRLIK_CSRF_SECRET",
): string {
  const value = environment[name];

  if (!value) {
    throw new Error(`${name} is required when native identity is enabled.`);
  }
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must be at least 32 bytes.`);
  }
  return value;
}

export function parseNativeAuthConfig(
  environment: Environment = process.env,
): NativeAuthConfig | null {
  if (
    parseIdentityProvider(environment.SEYIRLIK_IDENTITY_PROVIDER) !== "native"
  ) {
    return null;
  }

  const secureCookies = environment.NODE_ENV === "production";
  const sessionHashSecret = requiredSecret(
    environment,
    "SEYIRLIK_SESSION_HASH_SECRET",
  );
  const csrfSecret = requiredSecret(environment, "SEYIRLIK_CSRF_SECRET");
  if (sessionHashSecret === csrfSecret) {
    throw new Error(
      "SEYIRLIK_SESSION_HASH_SECRET and SEYIRLIK_CSRF_SECRET must be different.",
    );
  }

  return {
    sessionHashSecret,
    csrfSecret,
    secureCookies,
    sessionCookieName: secureCookies
      ? "__Secure-seyirlik_session"
      : "seyirlik_session",
    csrfCookieName: secureCookies ? "__Secure-seyirlik_csrf" : "seyirlik_csrf",
  };
}
