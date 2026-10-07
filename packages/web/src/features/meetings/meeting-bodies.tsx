import { Link } from "@tanstack/solid-router";
import { For } from "solid-js";
import type { ListedBody } from "./list";

/**
 * The bodies that held a meeting, each linking to its page: "Girdwood Board of
 * Supervisors", or for a joint meeting "Girdwood Board of Supervisors and
 * Girdwood Land Use Committee".
 */
export function MeetingBodies(props: {
  meeting: { bodies: ListedBody[] };
  class?: string;
}) {
  const bodies = () => props.meeting.bodies;
  return (
    <For each={bodies()}>
      {(body, i) => (
        <>
          {separator(i(), bodies().length)}
          <Link
            to="/bodies/$id"
            params={{ id: String(body.id) }}
            class={props.class}
          >
            {body.name}
          </Link>
        </>
      )}
    </For>
  );
}

/** What goes before the `i`th of `n` names: "A", "A and B", "A, B and C". */
function separator(i: number, n: number): string {
  if (i === 0) return "";
  return i === n - 1 ? " and " : ", ";
}
