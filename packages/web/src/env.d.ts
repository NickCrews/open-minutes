interface ImportMetaEnv {
  /**
   * The object store's public base URL, baked in at build time by
   * vite.config.ts from OBJECT_STORE_PUBLIC_URL. See `~/lib/audio-store`.
   */
  readonly OBJECT_STORE_PUBLIC_URL?: string;
}
