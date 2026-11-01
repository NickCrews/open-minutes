import type { BlobFile, BlobStore } from "./index";

/** The store's files, each made by `file` from its key. */
export function storeOf(file: (key: string) => BlobFile): BlobStore {
  return {
    youtube(youtubeId) {
      const prefix = `youtube/${encodeURIComponent(youtubeId)}`;
      return {
        metadataJson: file(`${prefix}/metadata.json`),
        speechWebm: file(`${prefix}/speech.webm`),
      };
    },
    duckdbExport: file("exports/open-minutes.duckdb"),
  };
}
