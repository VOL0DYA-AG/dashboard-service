/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK?: string;
  readonly VITE_REALM?: string;
  readonly VITE_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
