/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { FLAG_COUNTRY_CODES } from "./src/lib/flagCountryCodes";

// flag-icons ships every flag in the world: ~270 CSS rules pulling ~3.5 MB of
// SVGs, all of which Vite emitted as assets and the PWA precached, for the ~40
// flags Seyirlik can actually show. This keeps only the rules whose country
// code appears in FLAG_COUNTRY_CODES; the rest never become assets at all.
function trimFlagIcons(): Plugin {
  const keptCodes = new Set(FLAG_COUNTRY_CODES);
  // Matches `.fi-xx{...}` and `.fi-xx.fi-squared{...}`, capturing the code.
  const flagRulePattern = /\.fi-([a-z0-9-]+)((?:\.[a-z0-9-]+)*)\{[^}]*\}/g;

  return {
    name: "seyirlik-trim-flag-icons",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("flag-icons") || !id.endsWith(".css")) {
        return null;
      }

      let keptRules = 0;
      let droppedRules = 0;

      const trimmed = code.replace(
        flagRulePattern,
        (rule: string, countryCode: string) => {
          // Only flag rules carry an image. Anything else under the `.fi-`
          // prefix is a shared utility (`.fi-squared` and friends) and has to
          // survive regardless of which flags are kept.
          if (!rule.includes("background-image")) {
            return rule;
          }

          if (keptCodes.has(countryCode)) {
            keptRules += 1;
            return rule;
          }

          droppedRules += 1;
          return "";
        },
      );

      this.info(
        `flag-icons: kept ${keptRules} rules, dropped ${droppedRules}.`,
      );

      return { code: trimmed, map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  // `process.env` is not populated from .env on its own, so an upstream set
  // there was silently ignored and the proxy fell back to a loopback port with
  // nothing behind it — which reaches the browser as an unexplained "invalid
  // response" at the login form.
  const environment = { ...process.env, ...loadEnv(mode, process.cwd(), "") };

  return {
    plugins: [
      trimFlagIcons(),
      react(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: "script-defer",
        scope: "/",
        includeAssets: [
          "favicon-16x16.png",
          "favicon-32x32.png",
          "apple-touch-icon.png",
        ],
        manifest: {
          name: "Seyirlik",
          short_name: "Seyirlik",
          description: "Personal media server interface",
          id: "/",
          start_url: "/",
          scope: "/",
          display: "standalone",
          orientation: "any",
          background_color: "#000000",
          theme_color: "#000000",
          categories: ["entertainment", "video", "media"],
          icons: [
            {
              src: "/pwa-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
            },
            {
              src: "/maskable-icon-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          globPatterns: [
            "index.html",
            "registerSW.js",
            "assets/**/*.{js,css,svg,png,webp}",
          ],
          globIgnores: ["**/*.{mp4,mkv,m3u8,ts,vtt,srt,ass}"],
          maximumFileSizeToCacheInBytes: 1024 * 1024,
          navigateFallbackDenylist: [
            // Everything the server owns lives under the versioned namespace, so
            // one rule replaces the per-endpoint list this used to carry.
            /^\/ownAPI\//,
            /\.(?:m3u8|ts|mp4|mkv|webm|vtt|srt|ass)$/i,
          ],
          runtimeCaching: [],
        },
      }),
    ],
    resolve: {
      alias: {
        "@": new URL("./src", import.meta.url).pathname,
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/setupTests.ts"],
      globals: true,
      // The dual-deck handoff suite needs a real decoder and runs under
      // `vitest.browser.config.ts` (`npm run test:browser`). jsdom would load
      // it and hang waiting for video that never plays.
      exclude: ["**/node_modules/**", "**/dist/**", "**/*.browser.test.tsx"],
      /*
       * Bounded on purpose, and this is not a performance setting.
       *
       * The packaging suites encode for real, and on macOS an `auto` encoder
       * resolves to VideoToolbox — of which the machine has a small, fixed
       * number of simultaneous sessions. Run one worker per core and the
       * seventh concurrent encode fails to open a session at all:
       *
       *   [h264_videotoolbox] Error retrieving the supported property
       *   dictionary err=-12903
       *   [out#0/hls] Nothing was written into output file
       *
       * which surfaces as a different integration test failing on every run,
       * for a reason that has nothing to do with what it asserts. Capping the
       * workers keeps the number of concurrent encoders inside what the
       * hardware will grant, which is what makes a full run reproducible
       * instead of a lottery.
       *
       * It belongs here rather than in a flag an operator has to remember: a
       * suite that only passes when invoked a particular way is a suite people
       * learn to disbelieve. The cost is roughly a minute on a full run.
       *
       * Tests that do not care which encoder they use should pin a software
       * one (see `scratchUnmount.integration.test.ts`); they then cost nothing
       * from this budget. Tests that exercise VideoToolbox deliberately keep
       * `auto` and are covered by the cap.
       */
      maxWorkers: 3,
      minWorkers: 1,
    },
    server: {
      proxy: {
        "/ownAPI": {
          target:
            environment.SEYIRLIK_OWN_API_UPSTREAM?.trim() ||
            "http://127.0.0.1:43110",
          // The upstream must see the browser's own Origin: it validates it, and
          // rewriting it here would make every dev origin look like the API's.
          changeOrigin: false,
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks: {
            hls: ["hls.js"],
          },
        },
      },
    },
  };
});
