import { createFileRoute, Link, useRouter } from "@tanstack/solid-router";
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
import { Duration } from "~/features/meetings/duration";
import { StartTime } from "~/features/meetings/start-time";
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
  const router = useRouter();
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
                <CardDescription class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StartTime
                    meetingId={meeting.id}
                    startTime={meeting.start_time}
                    timezone={meeting.body.timezone}
                    onSaved={() => void router.invalidate()}
                  />
                  <Duration durationSecs={meeting.duration_secs} />
                </CardDescription>
              </CardHeader>
              <CardContent>
                <HoverCard>
                  <HoverCardTrigger
                    as="span"
                    class="text-muted-foreground cursor-default text-sm underline decoration-dotted underline-offset-4"
                  >
                    {meeting.body.name}
                  </HoverCardTrigger>
                  <HoverCardPortal>
                    <HoverCardContent>
                      <div class="flex flex-col gap-1">
                        <p class="font-semibold">{meeting.body.name}</p>
                        <p class="text-muted-foreground text-sm">
                          {meeting.body.jurisdiction.name}
                          <Show when={meeting.body.jurisdiction.state}>
                            {(state) => <>, {state()}</>}
                          </Show>
                        </p>
                        <Link
                          to="/bodies/$id"
                          params={{ id: String(meeting.body.id) }}
                          class="text-sm font-medium hover:underline"
                        >
                          View body →
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
