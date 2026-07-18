import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { getMeetingById } from "~/features/meetings";
import { formatDuration, formatMeetingTime } from "~/lib/format";
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
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-2 text-2xl font-bold">
        {meeting().title || "(untitled)"}
      </h1>
      <p class="text-muted-foreground mb-4 text-sm">
        <Link
          to="/municipalities/$id"
          params={{ id: String(meeting().municipality.id) }}
          class="hover:underline"
        >
          {meeting().municipality.name}
        </Link>
        <Show when={meeting().start_time}>
          {(start) => <> — {formatMeetingTime(start())}</>}
        </Show>
      </p>
      <Show when={meeting().youtube_url}>
        <p class="mb-4">
          <a
            href={meeting().youtube_url!}
            target="_blank"
            rel="noreferrer"
            class="text-sm font-medium hover:underline"
          >
            Watch on YouTube
          </a>
        </p>
      </Show>
      <Show when={meeting().description}>
        <p class="text-muted-foreground mb-6 whitespace-pre-line text-sm">
          {meeting().description}
        </p>
      </Show>
      <h2 class="mb-4 border-b pb-2 text-lg font-semibold">Transcript</h2>
      <div class="flex flex-col gap-3">
        <For
          each={meeting().segments}
          fallback={
            <p class="text-muted-foreground">No transcript segments yet.</p>
          }
        >
          {(segment) => (
            <p class="leading-relaxed">
              <span class="font-semibold">
                <Show
                  when={segment.person}
                  fallback={
                    segment.speaker_number != null
                      ? `Speaker ${segment.speaker_number}`
                      : "Unknown"
                  }
                >
                  {(person) => (
                    <Link
                      to="/people/$id"
                      params={{ id: String(person().id) }}
                      class="hover:underline"
                    >
                      {person().name || "(unnamed)"}
                    </Link>
                  )}
                </Show>
              </span>
              <Show when={segment.start_secs}>
                {(start) => (
                  <span class="text-muted-foreground text-xs">
                    {" "}
                    [{formatDuration(start())}]
                  </span>
                )}
              </Show>
              : {segment.text}
            </p>
          )}
        </For>
      </div>
    </div>
  );
}
