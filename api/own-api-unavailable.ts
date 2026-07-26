import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requestId(request: IncomingMessage): string {
  const supplied = request.headers["x-request-id"];
  return typeof supplied === "string" && REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : randomUUID();
}

export default function ownApiUnavailableHandler(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const correlationId = requestId(request);
  response.statusCode = 503;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Request-Id", correlationId);
  response.end(
    JSON.stringify({
      error: {
        code: "PRODUCTION_ROUTING_UNAVAILABLE",
        message:
          "The persistent own-API backend is not configured for this deployment.",
        requestId: correlationId,
      },
    }),
  );
}
