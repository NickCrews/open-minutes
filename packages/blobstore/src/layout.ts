import type { Site } from "@open-minutes/core/site";
import type { BlobFile, BlobStore, ContentType } from "./index";

/** The store's files, each made by `file` from its key and content type. */
export function storeOf(
  file: (key: string, contentType: ContentType) => BlobFile,
): BlobStore {
  return {
    recording(site, id) {
      const prefix = `${site}/${recordingDir(site, id)}`;
      return {
        metadataJson: file(`${prefix}/metadata.json`, "application/json"),
        audio: file(`${prefix}/speech.webm`, "audio/webm"),
      };
    },
    duckdbExport: file(
      "exports/open-minutes.duckdb",
      "application/octet-stream",
    ),
  };
}

/**
 * The directory a recording's files are in, under its site's: its ID, with an
 * akleg.gov meeting ID's spaces made underscores and its colons dropped
 * ("HRES 2018-09-10 14:00:00" is "HRES_2018-09-10_140000"). Throws on an ID
 * that isn't one path segment.
 */
export function recordingDir(site: Site, id: string): string {
  if (!id || id === "." || id === ".." || id.includes("/")) {
    throw new Error(`Not a ${site} recording ID: ${JSON.stringify(id)}`);
  }
  return site === "akleg" ? id.replaceAll(" ", "_").replaceAll(":", "") : id;
}

/**
 * `key` as a URL path: each segment percent-encoded, so a key with "&" (as
 * in akleg.gov's "SL&C" committee) names the same object in a URL.
 */
export function keyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
