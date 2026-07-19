import type { ComponentProps, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";
import { Tooltip as TooltipPrimitive } from "@kobalte/core/tooltip";

import { cx } from "~/lib/cva";

export const TooltipPortal = TooltipPrimitive.Portal;

export type TooltipProps = ComponentProps<typeof TooltipPrimitive>;

export const Tooltip = (props: TooltipProps) => {
  return <TooltipPrimitive data-slot="tooltip" gutter={4} {...props} />;
};

export type TooltipTriggerProps<T extends ValidComponent = "button"> =
  ComponentProps<typeof TooltipPrimitive.Trigger<T>>;

export const TooltipTrigger = <T extends ValidComponent = "button">(
  props: TooltipTriggerProps<T>,
) => {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
};

export type TooltipContentProps<T extends ValidComponent = "div"> =
  ComponentProps<typeof TooltipPrimitive.Content<T>>;

export const TooltipContent = <T extends ValidComponent = "div">(
  props: TooltipContentProps<T>,
) => {
  const [, rest] = splitProps(props as TooltipContentProps, ["class"]);

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        class={cx(
          "bg-popover text-popover-foreground data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 z-50 origin-(--kb-tooltip-content-transform-origin) rounded-md border px-2 py-1 text-xs shadow-md outline-hidden",
          props.class,
        )}
        {...rest}
      />
    </TooltipPrimitive.Portal>
  );
};
