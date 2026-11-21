/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  readonly VITE_API_BEARER_TOKEN?: string;
  readonly VITE_REFRESH_TOKEN?: string;
}
