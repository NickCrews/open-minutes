import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import { getBodyById } from "~/features/bodies";
import { MeetingBodies } from "~/features/meetings/meeting-bodies";
import { MeetingThumbnail } from "~/features/meetings/meeting-thumbnail";
import { formatMeetingDate } from "@open-minutes/core/meeting-date";
import {
  meetingSourceLabel,
  meetingSourceUrl,
} from "@open-minutes/core/meeting-source";
import { db } from "~/server/db";
import { z } from "zod";

const fetchBody = createServerFn({ method: "GET" })
  .inputValidator(z.int().positive())
  .handler(({ data }) => getBodyById(db(), data));

export const Route = createFileRoute("/bodies_/$id")({
  loader: ({ params }) => fetchBody({ data: Number(params.id) }),
  component: BodyPage,
});

function BodyPage() {
  const body = Route.useLoaderData();
  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-2 text-2xl font-bold">{body().name || "(unnamed)"}</h1>
      <p class="text-muted-foreground mb-4 text-sm">
        {body().jurisdiction.name}
        {body().jurisdiction.state ? `, ${body().jurisdiction.state}` : ""}
      </p>
      <Show when={body().meeting_source}>
        {(source) => (
          <p class="mb-4">
            <a
              href={meetingSourceUrl(source())}
              target="_blank"
              rel="noreferrer"
              class="text-sm font-medium hover:underline"
            >
              {meetingSourceLabel(source())}
            </a>
          </p>
        )}
      </Show>
      <h2 class="mb-4 border-b pb-2 text-lg font-semibold">Meetings</h2>
      <ul class="divide-y">
        <For
          each={body().meetings}
          fallback={
            <li class="text-muted-foreground py-2">No meetings yet.</li>
          }
        >
          {(meeting) => (
            <li class="flex items-center gap-4 py-2">
              <Link
                to="/meetings/$id"
                params={{ id: String(meeting.id) }}
                tabIndex={-1}
                class="w-24 shrink-0 sm:w-32"
              >
                <MeetingThumbnail meeting={meeting} />
              </Link>
              <div class="min-w-0">
                <Link
                  to="/meetings/$id"
                  params={{ id: String(meeting.id) }}
                  class="font-medium hover:underline"
                >
                  {meeting.title || "(untitled)"}
                </Link>
                <Show when={formatMeetingDate(meeting)}>
                  {(when) => (
                    <p class="text-muted-foreground text-sm">{when()}</p>
                  )}
                </Show>
                {/* A joint meeting names everyone who held it. */}
                <Show when={meeting.cohosts.length > 0}>
                  <p class="text-muted-foreground text-sm">
                    Joint meeting of{" "}
                    <MeetingBodies meeting={meeting} class="hover:underline" />
                  </p>
                </Show>
              </div>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
