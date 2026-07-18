import { loadRootDotEnv } from "./packages/core/src/dotenv.mjs";

loadRootDotEnv();

// Tests must never touch a named remote database (they create and drop
// databases), so pin resolution to "local" regardless of what $DB says.
// Explicit URLs passed in code still win.
process.env.DB = "local";
