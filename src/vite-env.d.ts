/// <reference types="vite/client" />

/**
 * Browser-visible configuration.
 *
 * Seyirlik's API is served from the page's own origin, so there is no server URL
 * to configure and no provider to select. What remains is Firebase, used only by
 * the developer tools.
 */
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_ADMIN_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
