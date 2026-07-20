import { Link } from "@tanstack/solid-router";
import { type JSX, Show } from "solid-js";
import {
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
} from "~/components/hover-card";

/** The little a hover card needs, so any query selecting these can feed it. */
export type HoverCardPerson = {
  id: number;
  name: string | null;
  bio: string | null;
};

/**
 * A person's name, linking to their page, with their bio on hover.
 *
 * The link is the trigger rather than a wrapper around it: a hover card that
 * isn't itself the link leaves the name un-clickable on touch, where there is
 * no hover to open the card in the first place.
 */
export function PersonHoverCard(props: {
  person: HoverCardPerson;
  /** What the name reads as here — a transcript may show a placeholder. */
  label?: string;
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <HoverCard>
      {/* `as` takes a render function rather than `as={Link}`: handed the bare
          component, TanStack can't infer the route from the `to` literal and
          `params` stops typechecking against it. */}
      <HoverCardTrigger
        as={(triggerProps: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) => (
          <Link
            {...triggerProps}
            to="/people/$id"
            params={{ id: String(props.person.id) }}
          />
        )}
        class={props.class ?? "hover:underline"}
      >
        {props.children ?? props.label ?? props.person.name ?? "(unnamed)"}
      </HoverCardTrigger>
      {/* Portaled: both call sites sit inside `overflow-y-auto` panes that
          would otherwise clip the card. */}
      <HoverCardPortal>
        <HoverCardContent class="w-72">
          <p class="font-medium">{props.person.name || "(unnamed)"}</p>
          <Show
            when={props.person.bio}
            fallback={
              <p class="text-muted-foreground mt-1 text-sm italic">
                No bio yet.
              </p>
            }
          >
            <p class="text-muted-foreground mt-1 text-sm whitespace-pre-wrap">
              {props.person.bio}
            </p>
          </Show>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}
