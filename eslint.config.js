import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.output/**",
      "**/data/**",
      "**/models/**",
      "**/routeTree.gen.ts",
      "**/migrations/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // sherpa-onnx-node ships no types, so audio declares them itself. Its
    // modules reference that declaration file so that packages importing them
    // typecheck without having to include it themselves.
    files: ["packages/audio/src/**"],
    rules: { "@typescript-eslint/triple-slash-reference": "off" },
  },
);
