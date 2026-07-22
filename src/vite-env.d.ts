/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_JELLYFIN_SERVER_URL?: string;
  readonly VITE_LOCAL_JELLYFIN_SERVER_URL?: string;
  readonly VITE_JELLYFIN_LOCAL_PROBE_URLS?: string;
  readonly VITE_SEYIRLIK_PLAYBACK_BACKEND_URL?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_ADMIN_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
