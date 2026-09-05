import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/components/notifications/*.browser.test.tsx"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }, { browser: "webkit" }],
    },
  },
});
