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
import { ensureEpochPackageFixture } from "./src/test/epochPackageFixture";

/**
 * Serves the generated renditions the way the media server does: complete
 * files, with byte ranges.
 *
 * Range support is not incidental here — the whole seamless path is only
 * offered for seekable complete-file sources, so a fixture server that ignored
 * `Range` would be testing something the production path never sees.
 */
function serveRenditionFixtures(): Plugin {
  const allowed = new Set([
    ...RENDITION_FIXTURES.map((fixture) => fixture.fileName),
    // Container benchmark pair: identical codecs, bitrate, resolution, duration
    // and GOP, differing only in progressive versus fragmented layout.
    "bench-progressive.mp4",
    "bench-fragmented.mp4",
    "bench-fragmented-sidx.mp4",
  ]);

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

/**
 * Serves a real assembled epoch package, the way the media server serves a
 * title folder: nested paths, spaces in filenames, and byte ranges.
 *
 * Byte ranges are not optional here. A single-file CMAF rendition is addressed
 * entirely by them, so a fixture server that ignored `Range` would hand the
 * player the whole file for every segment and prove nothing about the packaging
 * this suite exists to check.
 */
function serveEpochPackage(): Plugin {
  return {
    name: "seyirlik-serve-epoch-package",
    async configureServer(server) {
      const titleRoot = await ensureEpochPackageFixture().catch((error) => {
        console.warn(
          "[seyirlik] the epoch playback fixture could not be built:",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      });
      server.middlewares.use(
        "/test-epoch-package",
        (request, response, next) => {
          if (!titleRoot) {
            next();
            return;
          }
          const requested = decodeURIComponent(
            (request.url ?? "").split("?")[0].replace(/^\//, ""),
          );
          const filePath = path.resolve(titleRoot, requested);
          // A fixture server is still a server: a path that escapes the title
          // folder is refused rather than served.
          if (
            filePath !== path.resolve(titleRoot) &&
            !filePath.startsWith(`${path.resolve(titleRoot)}${path.sep}`)
          ) {
            response.statusCode = 403;
            response.end();
            return;
          }

          void stat(filePath)
            .then((stats) => {
              if (!stats.isFile()) {
                response.statusCode = 404;
                response.end();
                return;
              }
              response.setHeader(
                "Content-Type",
                filePath.endsWith(".m3u8")
                  ? "application/vnd.apple.mpegurl"
                  : filePath.endsWith(".m4a")
                    ? "audio/mp4"
                    : "video/mp4",
              );
              response.setHeader("Accept-Ranges", "bytes");
              response.setHeader("Cache-Control", "no-store");
              const range = /^bytes=(\d*)-(\d*)$/.exec(
                request.headers.range ?? "",
              );
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
        },
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), serveRenditionFixtures(), serveEpochPackage()],
  test: {
    include: ["src/**/*.browser.test.tsx"],
    // A real browser with a real decoder. jsdom has no video pipeline at all,
    // so nothing about frame readiness or a visible handoff can be observed
    // there — which is the whole reason this suite exists separately.
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      // Chromium covers the Chrome path that originally lost its rendition
      // ladder. WebKit exercises the Safari media/event fallbacks, where the
      // capability probe and hidden-deck frame readiness behave differently.
      instances: [{ browser: "chromium" }, { browser: "webkit" }],
    },
    // Decoding, seeking and a rendezvous take real wall-clock time.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
