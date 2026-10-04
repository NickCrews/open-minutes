import { createFileRoute } from "@tanstack/solid-router";
import { getLlmsTxtData, renderLlmsTxt } from "~/features/agents/llms-txt";
import { db } from "~/server/db";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const text = renderLlmsTxt(origin, await getLlmsTxtData(db()));
        return new Response(text, {
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
