/**
 * Shared helpers for OpenAI-compatible chat proxy middleware (NVIDIA, Azure).
 */

export function buildStructuredUserContent(
  prompt: string,
  schema: unknown
): string {
  return (
    `${prompt}\n\n` +
    `Respond with a single JSON object matching this JSON Schema exactly. ` +
    `Do not include markdown fences, prose, or commentary — the entire ` +
    `response must be valid JSON.\n\n` +
    `JSON Schema:\n${JSON.stringify(schema)}`
  );
}
