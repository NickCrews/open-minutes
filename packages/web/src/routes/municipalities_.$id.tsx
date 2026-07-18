import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { getMunicipalityById } from "~/features/municipalities";
import { formatMeetingTime } from "~/lib/format";
import { db } from "~/server/db";

const fetchMunicipality = createServerFn({ method: "GET" })
  .inputValidator((id: number) => id)
  .handler(({ data }) => getMunicipalityById(db(), data));

export const Route = createFileRoute("/municipalities_/$id")({
  loader: ({ params }) => fetchMunicipality({ data: Number(params.id) }),
  component: MunicipalityPage,
});

function MunicipalityPage() {
  const municipality = Route.useLoaderData();
  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-2 text-2xl font-bold">
        {municipality().name || "(unnamed)"}
        {municipality().state ? `, ${municipality().state}` : ""}
      </h1>
      <Show when={municipality().youtube_channel_url}>
        <p class="mb-4">
          <a
            href={municipality().youtube_channel_url!}
            target="_blank"
            rel="noreferrer"
            class="text-sm font-medium hover:underline"
          >
            YouTube channel
          </a>
        </p>
      </Show>
      <h2 class="mb-4 border-b pb-2 text-lg font-semibold">Meetings</h2>
      <ul class="divide-y">
        <For
          each={municipality().meetings}
          fallback={
            <li class="text-muted-foreground py-2">No meetings yet.</li>
          }
        >
          {(meeting) => (
            <li class="py-2">
              <Link
                to="/meetings/$id"
                params={{ id: String(meeting.id) }}
                class="font-medium hover:underline"
              >
                {meeting.title || "(untitled)"}
              </Link>
              <Show when={meeting.start_time}>
                {(start) => (
                  <span class="text-muted-foreground text-sm">
                    {" "}
                    — {formatMeetingTime(start())}
                  </span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
