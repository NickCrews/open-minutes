import { artwork } from "~/features/thumbnails/artwork";
import { cx } from "~/lib/cva";
import { initials } from "./initials";

/**
 * A person's picture: their initials on a gradient seeded by their id. We have
 * no photos of people, and the seed keeps each person's colors the same
 * everywhere. Decorative, since their name always sits beside it.
 */
export function PersonAvatar(props: {
  person: { id: number; name: string | null };
  class?: string;
}) {
  const art = () => {
    const key = `person:${props.person.id}`;
    return artwork({ palette: key, layout: key });
  };
  return (
    <div
      aria-hidden="true"
      class={cx(
        "flex shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white",
        props.class,
      )}
      style={{
        "background-image": `linear-gradient(135deg, ${art().from}, ${art().to})`,
      }}
    >
      {initials(props.person.name)}
    </div>
  );
}
