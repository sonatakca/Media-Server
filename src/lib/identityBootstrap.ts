import {
  ownApiClient,
  OwnApiClientError,
  type OwnApiNativeUser,
} from "../api/ownApi/client";
import { isAuthenticated } from "./authStorage";

export type IdentityProvider = "jellyfin" | "native";

export type IdentityBootstrapResult =
  | {
      provider: "jellyfin";
      status: "authenticated" | "anonymous";
      user: null;
    }
  | {
      provider: "native";
      status: "authenticated";
      user: OwnApiNativeUser;
    }
  | {
      provider: "native";
      status: "anonymous";
      user: null;
    };

export interface IdentityBootstrapDependencies {
  getNativeCurrentUser(): Promise<OwnApiNativeUser>;
  getJellyfinIdentity(): { authenticated: boolean };
}

const defaultDependencies: IdentityBootstrapDependencies = {
  getNativeCurrentUser: () => ownApiClient.getCurrentUser(),
  getJellyfinIdentity: () => ({ authenticated: isAuthenticated() }),
};

export function parseIdentityProvider(
  value: string | undefined,
): IdentityProvider {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "jellyfin";
  if (normalized === "jellyfin" || normalized === "native") return normalized;
  throw new Error("VITE_IDENTITY_PROVIDER must be either jellyfin or native.");
}

export async function bootstrapIdentity(
  { provider }: { provider: IdentityProvider } = { provider: "native" },
  dependencies: IdentityBootstrapDependencies = defaultDependencies,
): Promise<IdentityBootstrapResult> {
  if (provider === "jellyfin") {
    return {
      provider,
      status: dependencies.getJellyfinIdentity().authenticated
        ? "authenticated"
        : "anonymous",
      user: null,
    };
  }

  try {
    const user = await dependencies.getNativeCurrentUser();
    return { provider, status: "authenticated", user };
  } catch (error) {
    if (
      error instanceof OwnApiClientError &&
      error.status === 401 &&
      error.code === "AUTH_REQUIRED"
    ) {
      return { provider, status: "anonymous", user: null };
    }
    throw error;
  }
}
