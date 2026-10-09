import {
  DEFAULT_WORK_ROOT,
  type Sites,
  withDefaultSites,
} from "@open-minutes/pipeline";
import { type AudioMeeting, openMeeting } from "./audio/meeting";
import type { Db, ToolContext } from "./tool";

export interface ToolContextOptions {
  /**
   * Each site's metadata and audio, injectable for tests. Any not given come
   * from the environment.
   */
  sites?: Partial<Sites>;
  /** Where the pipeline steps keep work directories. */
  workRoot?: string;
}

/**
 * A {@link ToolContext} over `db`: a handle, or a function that opens one
 * (called at most once, the first time a tool needs the database).
 */
export function toolContext(
  db: Db | (() => Promise<Db>),
  options: ToolContextOptions = {},
): ToolContext {
  const sites = withDefaultSites(options.sites);
  let opened: Promise<Db> | null =
    typeof db === "function" ? null : Promise.resolve(db);
  const getDb = () => (opened ??= (db as () => Promise<Db>)());
  const meetings = new Map<string, Promise<AudioMeeting>>();
  return {
    db: getDb,
    meeting(ref) {
      const key = String(ref);
      let m = meetings.get(key);
      if (!m) {
        m = getDb().then((db) => openMeeting(ref, db));
        // Cache a meeting once it opens, but not a failure: if the audio
        // download drops, or the meeting isn't transcribed yet, the next call for
        // this ref should try again rather than rethrow the old error for the
        // life of the context. (The caller still gets the rejection from `m`;
        // this branch only evicts it.)
        m.catch(() => meetings.delete(key));
        meetings.set(key, m);
      }
      return m;
    },
    site: (kind) => sites[kind],
    workRoot: options.workRoot ?? DEFAULT_WORK_ROOT,
  };
}
