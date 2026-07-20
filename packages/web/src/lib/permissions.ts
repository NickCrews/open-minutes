/**
 * Who may edit the data behind the pages. There's no auth yet, so the answer is
 * "whoever is running the dev server" — but it lives here, in one definition,
 * so that adding real auth is one edit rather than a hunt through every
 * affordance.
 *
 * `import.meta.env.DEV` is what makes this safe to use on both sides of the
 * wire: Vite folds it per bundle, so in production this compiles to `return
 * false` on the client and `assertCanEdit` to an unconditional throw on the
 * server — an endpoint that can only throw, rather than a hidden button with a
 * live endpoint behind it.
 *
 * Being a function across a chunk boundary does cost dead-code elimination: the
 * editors' markup still ships to the client as unreachable code, where an
 * inlined `import.meta.env.DEV` would have been folded away. That's the price
 * of having one definition to change when real auth arrives.
 */
export function canEdit() {
  return import.meta.env.DEV;
}

/**
 * The server-side half of {@link canEdit}, for the top of a mutating server fn.
 * `what` names the thing being edited, e.g. "meeting times".
 */
export function assertCanEdit(what: string) {
  if (!canEdit())
    throw new Error(`Editing ${what} is a development-only affordance`);
}
