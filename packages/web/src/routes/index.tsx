import { createFileRoute, Link } from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/card";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function SectionCard(props: { title: string; description: string }) {
  return (
    <Card class="hover:bg-accent h-full transition-colors">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function HomePage(): JSX.Element {
  return (
    <div class="mx-auto max-w-3xl">
      <h1 class="mb-2 text-2xl font-bold">Open Minutes</h1>
      <p class="text-muted-foreground mb-6">
        Browse municipal meeting transcripts.
      </p>
      <div class="grid gap-4 sm:grid-cols-2">
        <Link to="/meetings">
          <SectionCard
            title="Meetings"
            description="Browse meetings and their transcripts."
          />
        </Link>
        <Link to="/people">
          <SectionCard
            title="People"
            description="Speakers identified across meetings."
          />
        </Link>
        <Link to="/municipalities">
          <SectionCard
            title="Municipalities"
            description="The local governments being tracked."
          />
        </Link>
        <Link to="/search" search={{ q: "" }}>
          <SectionCard
            title="Search"
            description="Full-text search across all transcripts."
          />
        </Link>
      </div>
    </div>
  );
}
