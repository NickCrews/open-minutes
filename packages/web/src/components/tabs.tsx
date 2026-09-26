import type { ComponentProps, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";
import { Tabs as TabsPrimitive } from "@kobalte/core/tabs";

import { cx } from "~/lib/cva";

export type TabsProps = ComponentProps<typeof TabsPrimitive>;

export const Tabs = (props: TabsProps) => {
  const [, rest] = splitProps(props, ["class"]);
  return (
    <TabsPrimitive
      data-slot="tabs"
      class={cx("flex flex-col gap-2", props.class)}
      {...rest}
    />
  );
};

export type TabsListProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof TabsPrimitive.List<T>
>;

export const TabsList = <T extends ValidComponent = "div">(
  props: TabsListProps<T>,
) => {
  const [, rest] = splitProps(props as TabsListProps, ["class"]);
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      class={cx(
        "bg-muted text-muted-foreground inline-flex h-9 w-fit shrink-0 items-center justify-center rounded-lg p-[3px]",
        props.class,
      )}
      {...rest}
    />
  );
};

export type TabsTriggerProps<T extends ValidComponent = "button"> =
  ComponentProps<typeof TabsPrimitive.Trigger<T>>;

export const TabsTrigger = <T extends ValidComponent = "button">(
  props: TabsTriggerProps<T>,
) => {
  const [, rest] = splitProps(props as TabsTriggerProps, ["class"]);
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      class={cx(
        "text-muted-foreground inline-flex h-full flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors outline-none",
        "hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow-sm",
        "disabled:pointer-events-none disabled:opacity-50",
        props.class,
      )}
      {...rest}
    />
  );
};

export type TabsContentProps<T extends ValidComponent = "div"> = ComponentProps<
  typeof TabsPrimitive.Content<T>
>;

export const TabsContent = <T extends ValidComponent = "div">(
  props: TabsContentProps<T>,
) => {
  const [, rest] = splitProps(props as TabsContentProps, ["class"]);
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      class={cx("min-h-0 flex-1 outline-none", props.class)}
      {...rest}
    />
  );
};
