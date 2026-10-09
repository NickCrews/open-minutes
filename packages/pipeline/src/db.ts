import type { DB } from "@open-minutes/db";

/** A database handle or an open transaction on one. */
export type Db = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];
