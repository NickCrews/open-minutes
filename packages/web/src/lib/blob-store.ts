import { getRouteApi } from "@tanstack/solid-router";
import { type BlobStore, blobStore } from "@open-minutes/blobstore";

/**
 * The blob store at the URL the server is configured with (see
 * ~/server/config), for the browser, which can't read the server's
 * environment. Call it where the root route's loader data is in reach: in a
 * component, or a function a component calls as it's set up.
 */
export function useBlobStore(): () => BlobStore {
  const config = getRouteApi("__root__").useLoaderData();
  return () => blobStore(config().blobStorePublicUrl);
}
