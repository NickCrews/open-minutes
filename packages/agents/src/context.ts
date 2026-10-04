import { type AudioMeeting, openMeeting } from "./audio/meeting";
import type { Db, ToolContext } from "./tool";

/**
 * A {@link ToolContext} over `db`: a handle, or a function that opens one
 * (called at most once, the first time a tool needs the database).
 */
export function toolContext(db: Db | (() => Promise<Db>)): ToolContext {
  let opened: Promise<Db> | null =
    typeof db === "function" ? null : Promise.resolve(db);
  const getDb = () => (opened ??= (db as () => Promise<Db>)());
  const meetings = new Map<string, Promise<AudioMeeting>>();
  return {
    db: getDb,
    meeting(ref) {
      let m = meetings.get(ref);
      if (!m) {
        m = openMeeting(ref, getDb);
        // Cache a meeting once it opens, but not a failure: if the audio
        // download drops, or the meeting isn't ingested yet, the next call for
        // this ref should try again rather than rethrow the old error for the
        // life of the context. (The caller still gets the rejection from `m`;
        // this branch only evicts it.)
        m.catch(() => meetings.delete(ref));
        meetings.set(ref, m);
      }
      return m;
    },
  };
}
