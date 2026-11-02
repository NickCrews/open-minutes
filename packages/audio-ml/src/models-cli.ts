#!/usr/bin/env -S npx vpx
// Download every ML model this package uses (~650MB), skipping any already
// present. Otherwise each is downloaded on first use.
//
//   pnpm models          download them
//   pnpm -s models --list
//                        print each model's spec as one JSON object per line,
//                        without downloading (CI hashes this into its model
//                        cache key)

import { ALL_MODEL_SPECS, ensureAllModels } from "./all-models";

if (process.argv.includes("--list")) {
  for (const spec of ALL_MODEL_SPECS) {
    console.log(JSON.stringify(spec));
  }
} else {
  ensureAllModels();
}
