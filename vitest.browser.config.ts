/// <reference types="vitest" />
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import {
  RENDITION_FIXTURES,
  ensureRenditionFixtures,
  getFixtureDirectory,
} from "./src/test/renditionFixtures";

/**
 * Serves the generated renditions the way the media server does: complete
 * files, with byte ranges.
 *
 * Range support is not incidental here — the whole seamless path is only
 * offered for seekable complete-file sources, so a fixture server that ignored
 * `Range` would be testing something the production path never sees.
 */
function serveRenditionFixtures(): Plugin {
  const allowed = new Set(
    RENDITION_FIXTURES.map((fixture) => fixture.fileName),
  );

  return {
    name: "seyirlik-serve-rendition-fixtures",
    async configureServer(server) {
      await ensureRenditionFixtures();

      server.middlewares.use("/test-media", (request, response, next) => {
        const fileName = path.basename(
          (request.url ?? "").split("?")[0].replace(/^\//, ""),
        );

        if (!allowed.has(fileName)) {
          next();
          return;
        }

        const filePath = path.join(getFixtureDirectory(), fileName);

        void stat(filePath)
          .then((stats) => {
            const range = /^bytes=(\d*)-(\d*)$/.exec(
              request.headers.range ?? "",
            );

            response.setHeader("Content-Type", "video/mp4");
            response.setHeader("Accept-Ranges", "bytes");
            response.setHeader("Cache-Control", "no-store");

            if (!range) {
              response.setHeader("Content-Length", stats.size);
              response.statusCode = 200;
              createReadStream(filePath).pipe(response);
              return;
            }

            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2]
              ? Math.min(Number(range[2]), stats.size - 1)
              : stats.size - 1;

            if (start >= stats.size || start > end) {
              response.statusCode = 416;
              response.setHeader("Content-Range", `bytes */${stats.size}`);
              response.end();
              return;
            }

            response.statusCode = 206;
            response.setHeader(
              "Content-Range",
              `bytes ${start}-${end}/${stats.size}`,
            );
            response.setHeader("Content-Length", end - start + 1);
            createReadStream(filePath, { start, end }).pipe(response);
          })
          .catch(() => {
            response.statusCode = 404;
            response.end();
          });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveRenditionFixtures()],
  test: {
    include: ["src/**/*.browser.test.tsx"],
    // A real browser with a real decoder. jsdom has no video pipeline at all,
    // so nothing about frame readiness or a visible handoff can be observed
    // there — which is the whole reason this suite exists separately.
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    // Decoding, seeking and a rendezvous take real wall-clock time.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
