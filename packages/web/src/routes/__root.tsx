import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import { HydrationScript } from "solid-js/web";
import { fetchPublicConfig } from "~/server/config";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charset: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Open Minutes" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // SVG first for crisp scaling; the PNG is the fallback for browsers
      // that don't support SVG icons (notably Safari).
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
    ],
  }),
  // The browser's share of the app's configuration (see ~/server/config).
  // It can't change while the page is open, so it's fetched once, with the
  // first page, and never again on navigation.
  loader: () => fetchPublicConfig(),
  staleTime: Infinity,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      {/* A fixed height that never wraps (it scrolls sideways if it must),
          so full-viewport pages like the meeting page can subtract it. */}
      <nav class="flex h-12 items-center gap-4 overflow-x-auto whitespace-nowrap border-b px-4 text-sm sm:text-base">
        <Link to="/" class="font-semibold hover:underline">
          Home
        </Link>
        <Link to="/meetings" class="text-muted-foreground hover:underline">
          Meetings
        </Link>
        <Link to="/people" class="text-muted-foreground hover:underline">
          People
        </Link>
        <Link to="/bodies" class="text-muted-foreground hover:underline">
          Boards &amp; Councils
        </Link>
        <Link
          to="/search"
          search={{ q: "" }}
          class="text-muted-foreground hover:underline"
        >
          Search
        </Link>
        <Link to="/about" class="text-muted-foreground hover:underline">
          About
        </Link>
      </nav>
      <main class="p-4">
        <Outlet />
      </main>
    </RootDocument>
  );
}

function RootDocument(props: { children: JSX.Element }) {
  return (
    <html>
      <head>
        {/* Bootstraps window._$HY; without it solid's hydrate() crashes and
            the app renders with zero client interactivity. */}
        <HydrationScript />
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
