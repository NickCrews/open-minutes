import { createFileRoute, Link } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { For, Show } from "solid-js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/card";
import {
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
} from "~/components/hover-card";
import { getAllMeetings } from "~/features/meetings";
import { formatMeetingTime } from "~/lib/format";
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
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-6 text-2xl font-bold">Meetings</h1>
      <div class="flex flex-col gap-4">
        <For
          each={meetings()}
          fallback={<p class="text-muted-foreground">No meetings yet.</p>}
        >
          {(meeting) => (
            <Card>
              <CardHeader>
                <CardTitle>
                  <Link
                    to="/meetings/$id"
                    params={{ id: String(meeting.id) }}
                    class="hover:underline"
                  >
                    {meeting.title || "(untitled)"}
                  </Link>
                </CardTitle>
                <CardDescription>
                  {meeting.start_time
                    ? formatMeetingTime(meeting.start_time)
                    : "Date unknown"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <HoverCard>
                  <HoverCardTrigger
                    as="span"
                    class="text-muted-foreground cursor-default text-sm underline decoration-dotted underline-offset-4"
                  >
                    {meeting.municipality.name}
                  </HoverCardTrigger>
                  <HoverCardPortal>
                    <HoverCardContent>
                      <div class="flex flex-col gap-1">
                        <p class="font-semibold">{meeting.municipality.name}</p>
                        <p class="text-muted-foreground text-sm">
                          {meeting.municipality.state}
                          <Show when={meeting.municipality.postcode}>
                            {(postcode) => <>, {postcode()}</>}
                          </Show>
                        </p>
                        <Show when={meeting.municipality.youtube_channel_url}>
                          {(url) => (
                            <a
                              href={url()}
                              target="_blank"
                              rel="noreferrer"
                              class="text-sm hover:underline"
                            >
                              YouTube channel
                            </a>
                          )}
                        </Show>
                        <Link
                          to="/municipalities/$id"
                          params={{ id: String(meeting.municipality.id) }}
                          class="text-sm font-medium hover:underline"
                        >
                          View municipality →
                        </Link>
                      </div>
                    </HoverCardContent>
                  </HoverCardPortal>
                </HoverCard>
              </CardContent>
            </Card>
          )}
        </For>
      </div>
    </div>
  );
}
