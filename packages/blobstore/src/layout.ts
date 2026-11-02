import type { BlobFile, BlobStore, ContentType } from "./index";

/** The store's files, each made by `file` from its key and content type. */
export function storeOf(
  file: (key: string, contentType: ContentType) => BlobFile,
): BlobStore {
  return {
    youtube(youtubeId) {
      const prefix = `youtube/${encodeURIComponent(youtubeId)}`;
      return {
        metadataJson: file(`${prefix}/metadata.json`, "application/json"),
        speechWebm: file(`${prefix}/speech.webm`, "audio/webm"),
      };
    },
    duckdbExport: file(
      "exports/open-minutes.duckdb",
      "application/octet-stream",
    ),
  };
}
