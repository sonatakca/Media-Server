/**
 * Keeps a running server running.
 *
 * Node ends the process for an uncaught exception and, since v15, for an
 * unhandled rejection too. For a long-lived server that trade is the wrong way
 * round: the faults that actually occur here are a dropped database socket, a
 * client that vanished mid-stream, a background job whose promise nobody
 * awaited — none of which have anything to do with the requests the server is
 * about to serve, and every one of which used to take the whole site down and
 * leave a browser looking at a proxy error.
 *
 * So after the server is listening, a fault is reported in full and the process
 * carries on. Before that point there is nothing to keep alive, and a startup
 * that failed should exit and let the supervisor try again.
 */
export function installProcessSafetyNet(isServing: () => boolean): void {
  const report = (kind: string, error: unknown): void => {
    console.error(
      `[Seyirlik] ${kind}:`,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  };

  process.on("uncaughtException", (error) => {
    report("Uncaught exception", error);
    if (!isServing()) {
      console.error("[Seyirlik] Faulted before the server was listening.");
      process.exit(1);
    }
    console.error("[Seyirlik] The server is still listening and continues.");
  });

  process.on("unhandledRejection", (reason) => {
    report("Unhandled promise rejection", reason);
    if (!isServing()) {
      console.error("[Seyirlik] Faulted before the server was listening.");
      process.exit(1);
    }
    console.error("[Seyirlik] The server is still listening and continues.");
  });
}
