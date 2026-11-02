/** "Kyle Kelley" → "KK"; one letter for a single name, "?" for none. */
export function initials(name: string | null): string {
  const words = (name ?? "").match(/\p{L}+/gu) ?? [];
  if (!words.length) return "?";
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : "";
  return (first + last).toUpperCase();
}
