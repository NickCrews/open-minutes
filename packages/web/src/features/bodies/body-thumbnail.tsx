import {
  type ArtworkSeeds,
  GeneratedArtwork,
  ThumbnailFrame,
} from "~/features/thumbnails/thumbnail";

export type ThumbnailBody = { id: number; name: string; name_short: string };

/**
 * Seeds for a body's artwork: its own palette and layout, its short name.
 * Its meetings' artwork borrows the palette and label; see `meetingSeeds`.
 */
export function bodySeeds(body: ThumbnailBody): ArtworkSeeds {
  const key = `body:${body.id}`;
  return { palette: key, layout: key, label: body.name_short || body.name };
}

/**
 * A body's picture in a list. Always generated artwork, never one of its
 * videos' thumbnails, so it looks the same however its meetings change, and
 * never like one of them.
 */
export function BodyThumbnail(props: { body: ThumbnailBody; class?: string }) {
  return (
    <ThumbnailFrame class={props.class}>
      <GeneratedArtwork seeds={bodySeeds(props.body)} />
    </ThumbnailFrame>
  );
}
