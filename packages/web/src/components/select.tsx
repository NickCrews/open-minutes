import type { ComponentProps, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";
import { Select as SelectPrimitive } from "@kobalte/core/select";

import { CheckIcon } from "~/components/icons";
import { cx } from "~/lib/cva";

export const Select = SelectPrimitive;
export const SelectValue = SelectPrimitive.Value;
export const SelectPortal = SelectPrimitive.Portal;

export type SelectTriggerProps<T extends ValidComponent = "button"> =
  ComponentProps<typeof SelectPrimitive.Trigger<T>>;

export const SelectTrigger = <T extends ValidComponent = "button">(
  props: SelectTriggerProps<T>,
) => {
  const [, rest] = splitProps(props as SelectTriggerProps, [
    "class",
    "children",
  ]);

  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      class={cx(
        "border-input data-[placeholder-shown]:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 flex h-9 w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        props.class,
      )}
      {...rest}
    >
      {props.children}
      <SelectPrimitive.Icon
        as="svg"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4 shrink-0 opacity-50"
      >
        <path d="m6 9 6 6 6-6" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
};

export type SelectContentProps<T extends ValidComponent = "div"> =
  ComponentProps<typeof SelectPrimitive.Content<T>>;

export const SelectContent = <T extends ValidComponent = "div">(
  props: SelectContentProps<T>,
) => {
  const [, rest] = splitProps(props as SelectContentProps, ["class"]);

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        class={cx(
          "bg-popover text-popover-foreground data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 relative z-50 max-h-80 min-w-32 origin-(--kb-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md",
          props.class,
        )}
        {...rest}
      >
        <SelectPrimitive.Listbox class="p-1 outline-none" />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
};

export type SelectItemProps<T extends ValidComponent = "li"> = ComponentProps<
  typeof SelectPrimitive.Item<T>
>;

export const SelectItem = <T extends ValidComponent = "li">(
  props: SelectItemProps<T>,
) => {
  const [local, rest] = splitProps(props as SelectItemProps, [
    "class",
    "children",
  ]);

  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      class={cx(
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        props.class,
      )}
      {...rest}
    >
      <SelectPrimitive.ItemLabel>{local.children}</SelectPrimitive.ItemLabel>
      <span class="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon class="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
};
