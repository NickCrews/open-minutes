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
        // A failed open (a typo'd name) shouldn't stick.
        m.catch(() => meetings.delete(ref));
        meetings.set(ref, m);
      }
      return m;
    },
  };
}
