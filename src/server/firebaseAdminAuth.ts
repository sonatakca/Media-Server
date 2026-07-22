import type { IncomingMessage } from "node:http";
import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

const FIREBASE_ADMIN_APP_NAME = "seyirlik-admin-backend";
const DEFAULT_ADMIN_EMAIL = "sonatakcaa@gmail.com";

export interface AdminAuthorizationSuccess {
  authorized: true;
  uid: string;
  email: string;
}

export interface AdminAuthorizationFailure {
  authorized: false;
  statusCode: 401 | 403 | 503;
  code:
    | "ADMIN_AUTH_REQUIRED"
    | "ADMIN_AUTH_INVALID"
    | "ADMIN_AUTH_FORBIDDEN"
    | "ADMIN_AUTH_NOT_CONFIGURED";
  message: string;
}

export type AdminAuthorizationResult =
  | AdminAuthorizationSuccess
  | AdminAuthorizationFailure;

export type AdminRequestAuthorizer = (
  request: IncomingMessage,
) => Promise<AdminAuthorizationResult>;

interface FirebaseAdminAuthorizerOptions {
  projectId: string;
  adminEmail?: string;
  verifyIdToken?: (token: string) => Promise<DecodedIdToken>;
}

function getFirebaseAdminApp(projectId: string): App {
  const existingApp = getApps().find(
    (app) => app.name === FIREBASE_ADMIN_APP_NAME,
  );

  return (
    existingApp ??
    initializeApp(
      {
        credential: applicationDefault(),
        projectId,
      },
      FIREBASE_ADMIN_APP_NAME,
    )
  );
}

function readBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;

  if (!authorization || Array.isArray(authorization)) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export function createFirebaseAdminAuthorizer(
  options: FirebaseAdminAuthorizerOptions,
): AdminRequestAuthorizer {
  const allowedEmail = (options.adminEmail ?? DEFAULT_ADMIN_EMAIL)
    .trim()
    .toLowerCase();
  const verifyIdToken =
    options.verifyIdToken ??
    ((token: string) =>
      getAuth(getFirebaseAdminApp(options.projectId)).verifyIdToken(
        token,
        true,
      ));

  return async (request) => {
    const token = readBearerToken(request);

    if (!token) {
      return {
        authorized: false,
        statusCode: 401,
        code: "ADMIN_AUTH_REQUIRED",
        message: "A Firebase administrator ID token is required.",
      };
    }

    let decodedToken: DecodedIdToken;

    try {
      decodedToken = await verifyIdToken(token);
    } catch {
      return {
        authorized: false,
        statusCode: 401,
        code: "ADMIN_AUTH_INVALID",
        message: "The Firebase administrator ID token is invalid or expired.",
      };
    }

    const tokenEmail = decodedToken.email?.trim().toLowerCase();
    const signInProvider = decodedToken.firebase?.sign_in_provider;

    if (
      decodedToken.email_verified !== true ||
      tokenEmail !== allowedEmail ||
      signInProvider !== "google.com"
    ) {
      return {
        authorized: false,
        statusCode: 403,
        code: "ADMIN_AUTH_FORBIDDEN",
        message:
          "This Google account is not authorized for administrator tools.",
      };
    }

    return {
      authorized: true,
      uid: decodedToken.uid,
      email: tokenEmail,
    };
  };
}

export function createUnavailableAdminAuthorizer(
  message = "Firebase administrator authentication is not configured on this backend.",
): AdminRequestAuthorizer {
  return async () => ({
    authorized: false,
    statusCode: 503,
    code: "ADMIN_AUTH_NOT_CONFIGURED",
    message,
  });
}

export function createFirebaseAdminAuthorizerFromEnv(): AdminRequestAuthorizer {
  const projectId = process.env.SEYIRLIK_FIREBASE_PROJECT_ID?.trim();

  if (!projectId) {
    return createUnavailableAdminAuthorizer(
      "SEYIRLIK_FIREBASE_PROJECT_ID is required for administrator endpoints.",
    );
  }

  return createFirebaseAdminAuthorizer({
    projectId,
    adminEmail:
      process.env.SEYIRLIK_FIREBASE_ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL,
  });
}
