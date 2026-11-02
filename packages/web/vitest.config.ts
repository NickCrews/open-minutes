import { mergeConfig } from "vite-plus";
import solidPlugin from "vite-plugin-solid";
import shared from "../../vitest.shared.ts";

// tsconfig.json preserves JSX for Solid's compiler, so tests that import a
// .tsx module need the Solid plugin too.
export default mergeConfig(shared, { plugins: [solidPlugin()] });
