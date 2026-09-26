import type { ComponentProps, JSX } from "solid-js";
import { splitProps } from "solid-js";
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";

import { cx } from "~/lib/cva";

/**
 * A panel that slides up from the bottom of the screen: a modal dialog shaped
 * for phones, where there's no room beside the main content for a side pane.
 */
export const Sheet = (props: ComponentProps<typeof DialogPrimitive>) => {
  return <DialogPrimitive data-slot="sheet" {...props} />;
};

export const SheetTrigger = DialogPrimitive.Trigger;

export const SheetContent = (props: {
  /** Names the sheet for screen readers; also shown as its heading. */
  title: string;
  class?: string;
  children: JSX.Element;
}) => {
  const [local] = splitProps(props, ["title", "class", "children"]);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        data-slot="sheet-overlay"
        class="data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 fixed inset-0 z-50 bg-black/50"
      />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        class={cx(
          "bg-background data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:slide-out-to-bottom data-[expanded]:slide-in-from-bottom fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col gap-3 rounded-t-xl border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-lg outline-none duration-200",
          local.class,
        )}
      >
        <div class="flex shrink-0 items-center justify-between gap-2">
          <DialogPrimitive.Title class="font-semibold">
            {local.title}
          </DialogPrimitive.Title>
          <DialogPrimitive.CloseButton
            class="text-muted-foreground hover:text-foreground hover:bg-accent -mr-1 inline-flex size-8 cursor-pointer items-center justify-center rounded-md"
            aria-label="Close"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              class="size-4"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </DialogPrimitive.CloseButton>
        </div>
        {local.children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
};
