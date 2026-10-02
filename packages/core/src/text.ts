// Stored text (transcripts, chapters, names and bios) writes a dash as a plain
// hyphen, never an en or em dash, so it reads and searches the same whether it
// came from a model, a recognizer or someone typing.

const TYPOGRAPHIC_DASH = /[–—]/u;
const TYPOGRAPHIC_DASHES = /[–—]/gu;

/** Whether `text` contains an en dash (–) or em dash (—). */
export function hasTypographicDash(text: string): boolean {
  return TYPOGRAPHIC_DASH.test(text);
}

/** `text` with every en and em dash replaced by a plain hyphen. */
export function plainDashes(text: string): string {
  return text.replace(TYPOGRAPHIC_DASHES, "-");
}
