import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import { HydrationScript } from "solid-js/web";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charset: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Open Minutes" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <nav class="flex gap-4 border-b px-4 py-3">
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
