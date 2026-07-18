import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For } from "solid-js";
import { getAllMeetings } from "~/features/meetings";
import { db } from "~/server/db";

const fetchMeetings = createServerFn({ method: "GET" }).handler(() =>
  getAllMeetings(db()),
);

export const Route = createFileRoute("/meetings")({
  loader: () => fetchMeetings(),
  component: MeetingsPage,
});

function MeetingsPage() {
  const meetings = Route.useLoaderData();
  return (
    <div>
      <h1>Meetings</h1>
      <ul>
        <For each={meetings()} fallback={<li>No meetings yet.</li>}>
          {(meeting) => (
            <li>
              <Link to="/meetings/$id" params={{ id: String(meeting.id) }}>
                {meeting.title || "(untitled)"}
              </Link>{" "}
              — {meeting.municipality.name}
              {meeting.start_time
                ? ` — ${meeting.start_time.toLocaleString()}`
                : ""}
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
