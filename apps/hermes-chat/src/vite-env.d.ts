/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_HERMEX_DEFAULT_SERVER_PUBKEY?: string;
  readonly VITE_HERMEX_DEFAULT_RELAYS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
