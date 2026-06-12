/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SEYIRLIK_PLAYBACK_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
