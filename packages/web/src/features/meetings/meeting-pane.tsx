import { Show } from "solid-js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/tabs";
import { cx } from "~/lib/cva";
import { type Segment } from "./speaker-identity";
import { Speakers } from "./speakers";

export type MeetingPaneTab = "info" | "speakers";

/**
 * Secondary facts about a meeting, one tab at a time, so they sit beside the
 * video and transcript instead of competing with them. Desktop shows it under
 * the video; phones open the same pane in a bottom sheet. Room is left for
 * more tabs (e.g. chapters) as they arrive.
 */
export function MeetingPane(props: {
  title: string;
  description: string;
  segments: Segment[];
  tab: MeetingPaneTab;
  onTabChange: (tab: MeetingPaneTab) => void;
  class?: string;
}) {
  return (
    <Tabs
      value={props.tab}
      onChange={(tab) => props.onTabChange(tab as MeetingPaneTab)}
      class={cx("min-h-0", props.class)}
    >
      <TabsList>
        <TabsTrigger value="info">Info</TabsTrigger>
        <TabsTrigger value="speakers">Speakers</TabsTrigger>
      </TabsList>
      <TabsContent value="info" class="overflow-y-auto text-sm">
        {/* The page header truncates the title on phones; spell it out here. */}
        <h2 class="mb-2 font-semibold lg:hidden">{props.title}</h2>
        <Show
          when={props.description}
          fallback={<p class="text-muted-foreground">No description.</p>}
        >
          <p class="text-muted-foreground whitespace-pre-line">
            {props.description}
          </p>
        </Show>
      </TabsContent>
      <TabsContent value="speakers" class="overflow-y-auto">
        <Speakers segments={props.segments} />
      </TabsContent>
    </Tabs>
  );
}
