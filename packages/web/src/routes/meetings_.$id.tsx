import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { getMeetingById } from "~/features/meetings";
import { db } from "~/server/db";

const fetchMeeting = createServerFn({ method: "GET" })
  .inputValidator((id: number) => id)
  .handler(({ data }) => getMeetingById(db(), data));

export const Route = createFileRoute("/meetings_/$id")({
  loader: ({ params }) => fetchMeeting({ data: Number(params.id) }),
  component: MeetingPage,
});

function MeetingPage() {
  const meeting = Route.useLoaderData();
  return (
    <div>
      <h1>{meeting().title || "(untitled)"}</h1>
      <p>
        <Link
          to="/municipalities/$id"
          params={{ id: String(meeting().municipality.id) }}
        >
          {meeting().municipality.name}
        </Link>
        <Show when={meeting().start_time}>
          {(start) => <> — {start().toLocaleString()}</>}
        </Show>
      </p>
      <Show when={meeting().youtube_url}>
        <p>
          <a href={meeting().youtube_url!}>Watch on YouTube</a>
        </p>
      </Show>
      <Show when={meeting().description}>
        <p>{meeting().description}</p>
      </Show>
      <h2>Transcript</h2>
      <For
        each={meeting().segments}
        fallback={<p>No transcript segments yet.</p>}
      >
        {(segment) => (
          <p>
            <strong>
              <Show
                when={segment.person}
                fallback={
                  segment.speaker_number != null
                    ? `Speaker ${segment.speaker_number}`
                    : "Unknown"
                }
              >
                {(person) => (
                  <Link to="/people/$id" params={{ id: String(person().id) }}>
                    {person().name || "(unnamed)"}
                  </Link>
                )}
              </Show>
            </strong>
            <Show when={segment.start_secs}>
              {(start) => <> [{start()}]</>}
            </Show>
            : {segment.text}
          </p>
        )}
      </For>
    </div>
  );
}
