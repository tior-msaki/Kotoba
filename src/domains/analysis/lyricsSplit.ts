/**
 * Split pasted lyrics into stanzas and lines for bottom-up analysis.
 *
 * Convention: blank line(s) separate stanzas; single newlines separate lines
 * within a stanza. Empty lines are dropped.
 */

export function splitPastedLyricsIntoStanzas(fullLyrics: string): string[][] {
  const normalized = fullLyrics.replace(/\r\n/g, "\n").trim();
  if (!normalized.length) return [];

  return normalized
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )
    .filter((lines) => lines.length > 0);
}
