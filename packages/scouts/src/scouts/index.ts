import type { Scout } from "@open-minutes/core/scout";
import { aklegScout } from "./akleg";
import { youtubeChannelScout } from "./youtube";

/**
 * Every scout. Schedules are UTC; Alaska is UTC-8 in summer and UTC-9 in
 * winter.
 */
export const SCOUTS: readonly Scout[] = [
  youtubeChannelScout({
    id: "gbos-youtube",
    name: "Girdwood Board of Supervisors' YouTube channel",
    channelId: "UCOUlNInprZEjhbpVPiJOlEA",
    bodies: ["gbos", "luc"],
    // Weekday mornings in Alaska.
    schedule: "0 17 * * 1-5",
  }),
  youtubeChannelScout({
    id: "moa-youtube",
    name: "Municipality of Anchorage's YouTube channel",
    channelId: "UCZDEuWj4IxdlwBhqrk62_XA",
    bodies: ["assembly", "pzc", "ced"],
    // Every six hours on weekdays.
    schedule: "0 */6 * * 1-5",
  }),
  aklegScout({
    id: "akleg",
    name: "Alaska Legislature committees on akleg.gov",
    committees: { hres: "HRES" },
    schedule: "0 15 * * *",
  }),
];
