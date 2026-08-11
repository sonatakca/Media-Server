/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  // `process.env` is not populated from .env on its own, so an upstream set
  // there was silently ignored and the proxy fell back to a loopback port with
  // nothing behind it — which reaches the browser as an unexplained "invalid
  // response" at the login form.
  const environment = { ...process.env, ...loadEnv(mode, process.cwd(), "") };

  return {
    plugins: [
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
