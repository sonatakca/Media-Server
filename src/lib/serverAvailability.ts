import {
  ownApiClient,
  OwnApiClientError,
  type OwnApiHealthResponse,
} from "../api/ownApi/client";
import { testServerConnection } from "./mediaApi";

export type ServerBootstrapProvider = "own-api" | "jellyfin";

export interface ServerAvailabilityInput {
  provider: ServerBootstrapProvider;
  serverUrl?: string;
  signal?: AbortSignal;
}

interface ServerAvailabilityDependencies {
  getHealth: (options?: {
    signal?: AbortSignal;
  }) => Promise<OwnApiHealthResponse>;
  testJellyfinConnection: (serverUrl: string) => Promise<unknown>;
}

const defaultDependencies: ServerAvailabilityDependencies = {
  getHealth: (options) => ownApiClient.getHealth(options),
  testJellyfinConnection: testServerConnection,
};

export function parseServerBootstrapProvider(
  value: string | undefined,
): ServerBootstrapProvider {
  const normalized = value?.trim();

  if (!normalized) {
    return "jellyfin";
  }

  if (normalized === "own-api" || normalized === "jellyfin") {
    return normalized;
  }

  throw new Error(
    "VITE_SERVER_BOOTSTRAP_PROVIDER must be either own-api or jellyfin.",
  );
}

export async function checkServerAvailability(
  { provider, serverUrl, signal }: ServerAvailabilityInput = {
    provider: "own-api",
  },
  dependencies: ServerAvailabilityDependencies = defaultDependencies,
): Promise<{ provider: ServerBootstrapProvider }> {
  if (provider === "jellyfin") {
    await dependencies.testJellyfinConnection(serverUrl ?? "");
    return { provider };
  }

  const health = await dependencies.getHealth({ signal });

  if (!health.alive) {
    throw new OwnApiClientError({
      status: 503,
      code: "SERVER_NOT_ALIVE",
      message: "Seyirlik's native server is not alive.",
    });
  }

  return { provider };
}
