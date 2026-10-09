import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.ts";

// The `~/` imports, as in vite.config.ts.
export default mergeConfig(shared, {
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
});
