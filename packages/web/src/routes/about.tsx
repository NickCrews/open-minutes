import { createFileRoute, Link } from "@tanstack/solid-router";
import type { JSX } from "solid-js";

export const Route = createFileRoute("/about")({
  head: () => ({ meta: [{ title: "About · Open Minutes" }] }),
  component: AboutPage,
});

const ISSUES_URL = "https://github.com/nickcrews/open-minutes/issues";
const REPO_URL = "https://github.com/nickcrews/open-minutes";

function Section(props: { id?: string; title: string; children: JSX.Element }) {
  return (
    <section id={props.id} class="mb-8 scroll-mt-4">
      <h2 class="mb-3 text-xl font-semibold">{props.title}</h2>
      <div class="space-y-3">{props.children}</div>
    </section>
  );
}

function ExternalLink(props: { href: string; children: JSX.Element }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      class="underline"
    >
      {props.children}
    </a>
  );
}

function AboutPage(): JSX.Element {
  return (
    <div class="mx-auto max-w-3xl leading-relaxed">
      <h1 class="mb-2 text-2xl font-bold">About Open Minutes</h1>
      <p class="text-muted-foreground mb-8 text-lg">
        Find out what was said at your local government's public meetings, and
        who said it, without watching hours of video.
      </p>

      <Section title="Why">
        <p>
          Local boards and assemblies make many decisions in public meetings,
          but the record is usually a multi-hour YouTube video and a few pages
          of written minutes. Finding out what your representatives said about
          snow removal, a zoning change or the budget means scrubbing through
          all that video.
        </p>
        <p>
          Open Minutes turns those recordings into searchable transcripts. For
          each meeting you can read everything that was said, see who said it,
          and jump straight to that moment in the video.
        </p>
        <p>
          Open Minutes is an early work in progress.{" "}
          <a href="#work-in-progress" class="underline">
            See what that means for you
          </a>
          .
        </p>
      </Section>

      <Section title="What you can do">
        <ul class="list-disc space-y-2 pl-6">
          <li>
            <Link to="/meetings" class="font-medium underline">
              Read a meeting
            </Link>{" "}
            as a transcript alongside its video. Click any word to play the
            video from that point.
          </li>
          <li>
            <Link to="/search" search={{ q: "" }} class="font-medium underline">
              Search what was said
            </Link>{" "}
            across every meeting, with each result linking to its meeting.
          </li>
          <li>
            <Link to="/people" class="font-medium underline">
              Follow a person
            </Link>{" "}
            across meetings: see every meeting they spoke in and everything they
            said.
          </li>
          <li>
            <Link to="/bodies" class="font-medium underline">
              Browse by board or council
            </Link>{" "}
            to see which meetings are available.
          </li>
        </ul>
      </Section>

      <Section title="How it works">
        <p>
          Open Minutes downloads the public meeting videos, and a computer does
          the rest. It writes down the words, works out where one speaker stops
          and the next one starts, and recognizes people who speak at more than
          one meeting by the sound of their voice. Nobody types up these
          transcripts by hand, so keep in mind:
        </p>
        <ul class="list-disc space-y-2 pl-6">
          <li>
            <strong>Transcripts contain mistakes.</strong> Names, local places
            and technical terms are the most likely to be misheard. The video is
            always the real record: check it before you quote someone.
          </li>
          <li>
            <strong>Who said what can be wrong.</strong> Voice recognition
            sometimes mixes up two people or splits one person in two. Until
            someone puts a name to a voice, a speaker shows as, say, "Anonymous
            Beaver".
          </li>
          <li>
            <strong>These are not official minutes.</strong> Your government's
            approved minutes remain the legal record of what was decided.
          </li>
        </ul>
      </Section>

      <Section
        id="work-in-progress"
        title="What “early work in progress” means"
      >
        <p>
          Open Minutes is useful for finding the moment something was said, but
          it is not yet complete or reliable enough to use on its own. In
          particular:
        </p>
        <ul class="list-disc space-y-2 pl-6">
          <li>
            <strong>Only some meetings are here.</strong> Few boards and
            councils are covered so far, and not every meeting of those has been
            processed. If you can't find a meeting, that doesn't mean it didn't
            happen.
          </li>
          <li>
            <strong>Most speakers don't have names yet.</strong> Names are added
            by hand, one voice at a time. A name on a speaker may also be wrong
            if voice recognition matched the wrong person.
          </li>
          <li>
            <strong>Search only finds the exact words you type.</strong> If the
            transcript misheard a word, searching for the right spelling won't
            find it, and only the 50 most recent matches are shown. Try shorter
            words or other spellings.
          </li>
          <li>
            <strong>Only some meetings have chapters</strong>, and those may not
            have been checked by a person yet.
          </li>
          <li>
            <strong>You can't fix mistakes on the site yet.</strong> There are
            no accounts or editing; report problems as described below.
          </li>
        </ul>
        <p>So use Open Minutes to find your way around, then:</p>
        <ul class="list-disc space-y-2 pl-6">
          <li>
            <strong>Watch the video</strong> before you quote someone or rely on
            what was said.
          </li>
          <li>
            <strong>Don't treat a missing search result as proof</strong> that
            nobody said something.
          </li>
          <li>
            <strong>Check who is speaking in the video</strong> before
            attributing a remark to a named person.
          </li>
          <li>
            <strong>Check the official minutes</strong> for what was actually
            decided.
          </li>
        </ul>
      </Section>

      <Section title="Who makes this">
        <p>
          Open Minutes is maintained by Nick Crews, a member of the Girdwood
          Board of Supervisors and a software engineer, because he needed a
          better way of browsing old meetings.
        </p>
      </Section>

      <Section title="Get involved">
        <p>
          Spot a mistake, or want a board or council added?{" "}
          <ExternalLink href={ISSUES_URL}>Open an issue</ExternalLink>.
        </p>
        <p>
          Open Minutes is open source. Developers and data analysts who want to
          run it themselves or query its database directly can find the code and
          instructions <ExternalLink href={REPO_URL}>on GitHub</ExternalLink>.
        </p>
      </Section>
    </div>
  );
}
