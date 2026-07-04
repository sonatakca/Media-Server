/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_JELLYFIN_SERVER_URL?: string;
  readonly VITE_LOCAL_JELLYFIN_SERVER_URL?: string;
  readonly VITE_JELLYFIN_LOCAL_PROBE_URLS?: string;
  readonly VITE_SEYIRLIK_PLAYBACK_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
