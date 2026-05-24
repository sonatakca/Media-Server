/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
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
        globIgnores: [
          "**/*.{mp4,mkv,m3u8,ts,vtt,srt,ass}",
          "**/jellyfin/**",
        ],
        maximumFileSizeToCacheInBytes: 1024 * 1024,
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/Items\//,
          /^\/Videos\//,
          /^\/Audio\//,
          /^\/LiveTv\//,
          /^\/Sessions\//,
          /^\/SyncPlay\//,
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
});
