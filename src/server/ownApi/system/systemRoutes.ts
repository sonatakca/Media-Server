import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import type { RestartController } from "../../restartController";

/**
 * Server lifecycle, for administrators.
 *
 * The `GET` exists so the page can tell "the button is not available here"
 * from "the button failed", and say which it is. A UI that only discovers a
 * disabled restart by pressing it has no way to explain why.
 */

export interface SystemRoutesOptions {
  restart: RestartController;
}

export function createSystemRoutes({
  restart,
}: SystemRoutesOptions): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/admin/system/restart",
      access: "admin",
      handle: async (context) => {
        sendData(context.response, context.requestId, restart.status());
      },
    },

    {
      method: "POST",
      path: "/admin/system/restart",
      access: "admin",
      handle: async (context) => {
        const result = restart.request();

        if (!result.accepted) {
          throw new OwnApiError(
            "RESTART_UNAVAILABLE",
            "This server is not configured to restart itself.",
            409,
          );
        }

        /*
         * Answered before anything stops.
         *
         * The controller schedules the shutdown behind a short grace period
         * precisely so this response reaches the browser first; the page needs
         * the acknowledgement to know it should start waiting rather than
         * treat the dropped connection as a failure.
         */
        sendData(
          context.response,
          context.requestId,
          { status: "restarting", mode: result.mode },
          202,
        );
      },
    },
  ];
}
