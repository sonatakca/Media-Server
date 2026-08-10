/// <reference types="vite/client" />

/**
 * Browser-visible configuration.
 *
 * Seyirlik's API is served from the page's own origin unless a deployment splits
 * the app and the API across hosts. Firebase values are unused by the app and
 * remain only for reference.
 */
interface ImportMetaEnv {
  /**
   * Origin of the own API, when it is not served from the same host as the app.
   * Must share a registrable domain with the app so requests stay same-site.
   */
  readonly VITE_OWN_API_BASE_URL?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_ADMIN_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
