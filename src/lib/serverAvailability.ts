import {
  ownApiClient,
  OwnApiClientError,
  type OwnApiHealthResponse,
} from "../api/ownApi/client";

/**
 * Confirms the server behind this origin is up before the app tries to use it.
 *
 * Seyirlik serves its own API, so there is nothing to configure and nothing to
 * choose: the check is unconditional and always against this origin.
 */

export interface ServerAvailabilityInput {
  signal?: AbortSignal;
}

interface ServerAvailabilityDependencies {
  getHealth: (options?: {
    signal?: AbortSignal;
  }) => Promise<OwnApiHealthResponse>;
}

const defaultDependencies: ServerAvailabilityDependencies = {
  getHealth: (options) => ownApiClient.getHealth(options),
};

export async function checkServerAvailability(
  { signal }: ServerAvailabilityInput = {},
  dependencies: ServerAvailabilityDependencies = defaultDependencies,
): Promise<void> {
  const health = await dependencies.getHealth({ signal });

  if (!health.alive) {
    throw new OwnApiClientError({
      status: 503,
      code: "SERVER_NOT_ALIVE",
      message: "The Seyirlik server is not alive.",
    });
  }
}
