import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import type { AlertClient } from "./alertClient";

/**
 * Hands an administrator's device what it needs to read alerts on its own.
 *
 * Asked while the server is up; used when it is not. The token is checked by
 * the alert service with the secret it shares with this server, so reading
 * alerts never depends on the thing whose failure they report.
 */
export function createAlertRoutes(
  alerts: AlertClient | null,
): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/alerts/viewer-token",
      access: "admin",
      handle: async (context) => {
        if (!alerts) {
          throw new OwnApiError(
            "ALERTS_NOT_CONFIGURED",
            "No alert service is configured for this server.",
            404,
          );
        }
        const principal = context.requirePrincipal();
        sendData(context.response, context.requestId, {
          url: alerts.url,
          token: await alerts.mintViewerToken(principal.userId),
        });
      },
    },
  ];
}
