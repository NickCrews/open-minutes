import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/solid-router";
import type { JSX } from "solid-js";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charset: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Open Minutes" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <nav style={{ display: "flex", gap: "1rem", padding: "1rem" }}>
        <Link to="/">Home</Link>
        <Link to="/meetings">Meetings</Link>
        <Link to="/people">People</Link>
        <Link to="/municipalities">Municipalities</Link>
        <Link to="/search" search={{ q: "" }}>
          Search
        </Link>
      </nav>
      <main style={{ padding: "0 1rem 1rem" }}>
        <Outlet />
      </main>
    </RootDocument>
  );
}

function RootDocument(props: { children: JSX.Element }) {
  return (
    <html>
      <head>
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
