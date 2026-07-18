import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { getMunicipalityById } from "~/features/municipalities";
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
    <div>
      <h1>
        {municipality().name || "(unnamed)"}
        {municipality().state ? `, ${municipality().state}` : ""}
      </h1>
      <Show when={municipality().youtube_channel_url}>
        <p>
          <a href={municipality().youtube_channel_url!}>YouTube channel</a>
        </p>
      </Show>
      <h2>Meetings</h2>
      <ul>
        <For
          each={municipality().meetings}
          fallback={<li>No meetings yet.</li>}
        >
          {(meeting) => (
            <li>
              <Link to="/meetings/$id" params={{ id: String(meeting.id) }}>
                {meeting.title || "(untitled)"}
              </Link>
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
