import {
  ownApiClient,
  OwnApiClientError,
  type OwnApiNativeUser,
} from "../api/ownApi/client";

/**
 * Answers "is anybody signed in?" before the app renders.
 *
 * The session lives in an `HttpOnly` cookie the page cannot read, so the only
 * way to know is to ask the server. A 401 is an answer, not a failure: it means
 * anonymous. Anything else really is a failure and must not be mistaken for
 * being signed out.
 */

export type IdentityBootstrapResult =
  | { status: "authenticated"; user: OwnApiNativeUser }
  | { status: "anonymous"; user: null };

export interface IdentityBootstrapDependencies {
  getCurrentUser(): Promise<OwnApiNativeUser>;
}

const defaultDependencies: IdentityBootstrapDependencies = {
  getCurrentUser: () => ownApiClient.getCurrentUser(),
};

export async function bootstrapIdentity(
  dependencies: IdentityBootstrapDependencies = defaultDependencies,
): Promise<IdentityBootstrapResult> {
  try {
    return {
      status: "authenticated",
      user: await dependencies.getCurrentUser(),
    };
  } catch (error) {
    if (
      error instanceof OwnApiClientError &&
      error.status === 401 &&
      error.code === "AUTH_REQUIRED"
    ) {
      return { status: "anonymous", user: null };
    }

    throw error;
  }
}
