import { createFileRoute, Link } from "@tanstack/solid-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div>
      <h1>Open Minutes</h1>
      <p>Browse municipal meeting transcripts.</p>
      <ul>
        <li>
          <Link to="/meetings">Meetings</Link>
        </li>
        <li>
          <Link to="/people">People</Link>
        </li>
        <li>
          <Link to="/municipalities">Municipalities</Link>
        </li>
        <li>
          <Link to="/search" search={{ q: "" }}>
            Search
          </Link>
        </li>
      </ul>
    </div>
  );
}
